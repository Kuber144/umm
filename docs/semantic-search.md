# Search by meaning

`GET /api/items` and MCP `search_memory` fuse two lists when `q` is set: FTS5 keyword hits (all words, prefix match) and the closest items by embedding. The default is `mode=hybrid`. `mode=keyword`, a missing model or an item without a vector gives today's keyword search.

## How it works

- Model: multilingual-e5-small, int8 ONNX (`Xenova/multilingual-e5-small`, 118 MB), 384 dims, English and Hindi. `model/` in the data folder holds it. The first save downloads it, a search never does.
- It runs in a child process (`backend/embed.py`) that the parent kills after 3 idle minutes. Deleting the model inside one process left 430 of 740 MB in use in a test, a process exit returns all of it.
- Vectors are float16 bytes (768 B) in a `vec` column of `items`. Deleting an item deletes its vector. An edit clears it and the item is embedded again.
- Saves, edits and app start call `db.embed_pending()` in a thread. It embeds every row with no vector, so old items are backfilled too. An MCP save does the same in the MCP process, and the next app start finishes whatever it left.
- Ranking is reciprocal rank fusion (k=60). The cosine list is brute force in numpy over the rows that pass the filters, top 20, at least 0.8 and within 0.06 of the best. All filters and `sort` still apply.
- Only the first 256 tokens of an item are embedded. Keywords still cover the rest of a long OCR page.
- To re-embed after a model change, run `UPDATE items SET vec = NULL`.

## Options measured

24 queries over 40 seeded items (notes, paths, links, OCR with typos, Hindi, Hinglish, voice, agent facts). Apple Silicon M3. RSS is the growth after loading the model, in the process that loads it.

| Option | RSS | Embed per item | MRR | Notes |
| --- | --- | --- | --- | --- |
| Keyword (today) | 0 | 0 | 0.17 | 20 of 24 queries return nothing, AND match |
| Apple NLEmbedding (en) | +55 MB | 6 ms | 0.47 | No Hindi model (`hi` is not offered) |
| Apple NLContextualEmbedding | +106 MB | 60 ms | 0.37 | Hindi assets are not on the machine |
| paraphrase-multilingual-MiniLM-L12-v2, fp32, fastembed | +830 MB | 4 ms | 0.92 | |
| same, int8 | +613 MB | 2 ms | 0.90 | |
| potion-multilingual-128M, fastembed | +1.6 GB | 0.1 ms | 0.83 | |
| multilingual-e5-small, fp32 | +977 MB | 5 ms | 0.94 | 470 MB download |
| multilingual-e5-small, int8 (chosen) | +640 MB, 410 MB after the tokenizer swap below | 2 ms | 0.93 | 118 MB download |

I did not measure sentence-transformers. It needs torch, which is larger than every row above before it loads a model.

Two changes cut the chosen model's memory. The Hugging Face tokenizer holds 400 MB for the 250k vocabulary, so `embed.py` uses sentencepiece (28 MB) and maps ids with +1 and the XLM-R specials. Turning off the ONNX memory arena and embedding 4 items at a time cut the peak while backfilling from 590 MB to 530 MB with the same speed.

## Numbers for the chosen setup

- Idle backend: 105 MB, same as before. 123 MB after the first search. The child is gone 180 s after the last use.
- Child: 407 MB loaded and idle, about 530 MB peak during backfill.
- Cold search (spawn, load, embed): 0.4 s. Warm: 3.6 ms at 1000 items, 13 ms at 3000, against 0.1 to 1.5 ms for keyword.
- Embed: 2 ms for a short note, 18 ms at 256 tokens. Backfill of 3000 short items took 46 s including SQLite commits.
- First download plus embedding the 40 seed items: 25 s.
- Disk: 0.6 to 0.9 MB per 1000 items for vectors (768 B each plus FTS row rewrite), 120 MB once for the model.
- Code: `embed.py` is 71 lines and `db.py` grows by about 45 net. The one new dependency is `sentencepiece` (1.3 MB). `onnxruntime`, `numpy` and `huggingface-hub` were already in the lock through faster-whisper.

## Quality

Seeded 40 items plus 3000 filler items made from templates (notes, recipes, paths, links, orders, Hindi lines), 24 queries.

| Seed only | MRR | Hit at 1 | Hit at 3 | No result |
| --- | --- | --- | --- | --- |
| Keyword | 0.17 | 4 of 24 | 4 of 24 | 20 |
| Hybrid | 0.95 | 22 of 24 | 24 of 24 | 0 |

| With 3000 fillers | MRR | Hit at 1 | Hit at 3 | No result |
| --- | --- | --- | --- | --- |
| Keyword | 0.17 | 4 of 24 | 4 of 24 | 20 |
| Hybrid | 0.84 | 20 of 24 | 20 of 24 | 2 |

Examples, hybrid rank 1 where keyword found nothing:

| Query | Found |
| --- | --- |
| what test runner does the user like | "User prefers pytest for Python tests" |
| wifi login | "Wi-Fi password: bluemango42" (OCR) |
| netflix subscription payment receipt | "Recieved your paymnet ... subscripton ... Netflx Inc." (typos) |
| monthly house payment to landlord | "Apartment rent is 28000 per month ... landlord Mr. Sharma" |
| how do I avoid exposing the server on a network port | "backend runs on a unix socket, no TCP ports" |
| बिजली बिल कब भरना है | "बिजली का बिल हर महीने की 10 तारीख तक भरना है" |
| doctor appointment tomorrow evening | the Hindi doctor note |
| milk and eggs shopping | the Hinglish "doodh aur anda" note (rank 14 with fillers) |

Misses:

- "what languages does the user speak" and "workflow rules for source control branches" fall outside the top 20 once fillers are added.
- "coffee with plant based milk" does not find "I always drink oat milk lattes". A small model is weak at loose paraphrase.
- A query with no match returns up to 20 weak hits. e5 scores for gibberish (0.81 to 0.87) overlap real matches (0.80 to 0.90), so no threshold separates them. Keyword hits always rank above them. `mode=keyword` gives the strict list.

## Limits

- Everything above uses my own queries and fillers. Real data will differ. The 0.8 and 0.06 cutoffs were tuned on them.
- The schema change rebuilds the FTS table once, and writes `umm.db.bak` first, like the earlier `meta` migration. If the app and an MCP server start together on an old database, both may try it. Start the app first.
- `mcp_server.py` still tells agents to use short keywords, and its `query` description says AND-matched. Both are stale and are left for the description pass.
