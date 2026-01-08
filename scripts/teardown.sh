#!/bin/sh
set -e

printf "This will stop and remove containers, networks, and volumes for this project.\n"
read -r -p "Type 'destroy' to continue: " confirm

if [ "$confirm" != "destroy" ]; then
  echo "Aborted."
  exit 1
fi

docker compose down --volumes --remove-orphans

printf "\nPruning any dangling images (optional).\n"
read -r -p "Type 'prune' to remove dangling images: " prune
if [ "$prune" = "prune" ]; then
  docker image prune -f
fi

printf "Done.\n"
