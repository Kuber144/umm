#!/bin/bash
# deletes the "umm local signing" certificate from your keychain, builds go back to ad hoc signing
security delete-certificate -c "umm local signing" && echo "removed" || echo "not found, or remove it in Keychain Access"
