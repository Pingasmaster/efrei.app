#!/bin/sh
set -e

# Tear down all containers, networks, and volumes created by this project.
# The script is intentionally interactive to avoid accidental data loss.

printf "This will stop and remove containers, networks, and volumes for this project.\n"
read -r -p "Type 'destroy' to continue: " confirm

if [ "$confirm" != "destroy" ]; then
  echo "Aborted."
  exit 1
fi

# Stop services and delete volumes for a clean reset.
docker compose down --volumes --remove-orphans

printf "\nPruning any dangling images (optional).\n"
read -r -p "Type 'prune' to remove dangling images: " prune
if [ "$prune" = "prune" ]; then
  # Cleanup dangling layers to reclaim disk space.
  docker image prune -f
fi

printf "Done.\n"
