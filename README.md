# efrei.app

C'est le meileur site web de paris pour tout ce qui se passe à l'efrei.

Pariez avec des points, et echangez-les entre élèves ou pour des récompenses.

Ce projet comporte quatre conteneurs qui s'occupent de tout:

1. Frontend (Tier 1): Nginx sers les fichiers statiques qui se trouvent dans `www/`.
2. API Gateway / Auth (Tier 2): Une gateway express qui gère l'authentification et les proxies `/api/*` vers la logique métier.
3. Business API (Tier 3): Service express avec principalement des stubs pour l'instants pour la future logique métier.
4. Database (Tier 4): MySQL with persistent volume.
5. Cache (Bonus): Redis est utilisé pour cacher la DB.
6. Odds Worker (Bonus): Publies les côtes en temps réel vers redis pour le streaming en temps réel.

Tous les conteneurs utilisent le network interne "internal" de docker. POur lancer tout le projet il suffit de faire:

## Lancement de l'app

Au premier lancement il faut créer le .env et le customiser (obligatoire!!!):

```bash
cp .env.example .env
nano .env # Mettre les mots de passe requis
docker compose up --build
```

Pour tous lers lancement suivants on peut juste faire:

```bash
docker compose up --build
```

Les urls sont http://localhost:8080 pour le frontend, http://localhost:3000 pour la gateway et http://api:4000 pour l'api métier.

## Validation de l'environnement

Ce projet refuse de démarrer si le .env n'existe pas ou si il manque des valeurs. Pour démarrer, copiez le .env.exmaple en .env et mettez vos mots de passe:

Pour supprimer tous les conteneurs que ce projet démarre vous pouvez faire appel ça ce script dédié:

```bash
./scripts/teardown.sh
```

## Reverse proxy externe vers le vrai site (efrei.app)
Pour l'instant, ce projet nécessite qu'un reverse proxy externe nginx soit pointé vers le déploiement pour la prod https://efrei.app. 
Une config adéquate est donnée à `deploy/nginx-efrei.app.conf` pour la config du reverse proxy nginx. Il sera possiblement intégré dans l'app dans le futur, à voir.

## Côtes en temps réels via websockets
Pour ce site les côtes sont calculées et projetées en temps réel via un worker qui publie les côtes à redis (`ODDS_CHANNEL`), une API qui écoute et broadcast via des websockets sur `/ws/odds`, qui est connecté au fontend via la gateway `ws://localhost:3000/ws/odds`.
