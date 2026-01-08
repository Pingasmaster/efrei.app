# FULL_DESCRIPTION (backend + infra)

Ce document décrit l’état actuel de l’application côté **backend / infra / API** (hors frontend). Il couvre :
- Services et architecture Docker
- Configuration & variables d’environnement
- Modèle de données MySQL
- Authentification + rôles (admin / super admin / ban)
- Frais de 2% et transferts de points
- Journalisation (audit_logs)
- **Tous les endpoints** (gateway + API), leurs paramètres, leurs restrictions et leurs effets

---

## 1) Architecture & services (Docker)

Services principaux :
- **frontend** (Nginx) : sert les fichiers statiques. (Frontend non documenté ici.)
- **gateway** (Express) : Authentification + proxy `/api` et `/ws` vers l’API métier.
- **api** (Express) : logique métier (offres, paris, points, admin, logs). Utilise MySQL + Redis.
- **mysql** : persistance des données.
- **redis** :
  - Pub/sub odds (realtime) pour l’API.
- **odds-worker** : publie les cotes dans Redis + traite la queue de payouts des paris.
- **env-check** : valide l’environnement `.env` avant boot.

Flux :
```
client -> gateway (auth + proxy) -> api (métier)
client -> gateway /ws -> api /ws/odds
api <-> mysql
api <-> redis (odds pub/sub)
worker <-> mysql (payouts)
worker <-> redis (odds + queue payouts)
```

Note : la création de schéma MySQL est centralisée côté **api** (pour dev). Le gateway n’initialise plus les tables.

---

## 2) Variables d’environnement (extrait)

Fichier `.env.example` :
- **Ports**
  - `FRONTEND_PORT`, `GATEWAY_PORT`, `API_PORT`
- **Gateway/API**
  - `JWT_SECRET` (sert à **amorcer** `auth_secrets` s’il est vide)
  - `BUSINESS_API_URL` (gateway -> api)
- **DB**
  - `DB_HOST`, `DB_PORT`, `DB_NAME`, `DB_USER`, `DB_PASSWORD`, `MYSQL_ROOT_PASSWORD`
- **Redis**
  - `REDIS_HOST`, `REDIS_PORT`
- **Odds**
  - `ODDS_CHANNEL`, `ODDS_INTERVAL_MS`
- **Queue payouts**
  - `PAYOUT_QUEUE`, `PAYOUT_POLL_INTERVAL_MS`
- **Refresh tokens**
  - `REFRESH_TOKEN_DAYS`
- **Auth cache (gateway)**
  - `AUTH_CACHE_TTL_SECONDS`
- **Super admin bootstrap**
  - `ADMIN_BOOTSTRAP_EMAIL` ou `ADMIN_BOOTSTRAP_USER_ID`

**Important :** le gateway et l’API lisent leurs secrets depuis `auth_secrets`. `JWT_SECRET` sert uniquement de secret initial si la table est vide.

---

## 3) Modèle de données (MySQL)

### Table `users`
Champs principaux :
- `id`, `email`, `name`, `password_hash`
- `points INT UNSIGNED` **(défaut 1000)**
- `is_admin`, `is_super_admin`, `is_banned`, `banned_at`
- `profile_description` (TEXT, null par défaut)
- `profile_visibility` (`public` | `private`, défaut `public`)
- `profile_alias` (pseudonyme public optionnel)
- `profile_quote` (citation optionnelle)
- `created_at`, `updated_at`

### Tables RBAC (`roles`, `permissions`, `role_permissions`, `user_roles`)
RBAC fin basé sur permissions (utilisé côté API/gateway).
- `roles` : `admin`, `super_admin`, extensible.
- `permissions` : `admin.access`, `admin.super`, etc.
- `role_permissions` : mapping M:N.
- `user_roles` : attribution des rôles (avec `assigned_by`).

### Table `user_devices`
- `user_id`, `fingerprint`, `user_agent`, `last_ip`
- `first_seen`, `last_seen`

### Table `user_groups`
- `name`, `description`
- `is_private` (défaut 1)
- `created_by`, `created_at`, `updated_at`

### Table `group_members`
- `group_id`, `user_id`
- `role` (défaut `member`)
- `created_at`

### Table `offers`
- `creator_user_id`
- `group_id` (NULL = public)
- `title`, `description`
- `points_cost`
- `max_acceptances` (NULL = infini)
- `accepted_count`, `is_active`
- `created_at`, `updated_at`

### Table `offer_acceptances`
- `offer_id`, `accepter_user_id`, `points_cost`, `created_at`

### Table `offer_reviews`
- `offer_id`, `reviewer_user_id`
- `rating` (1-5), `comment`
- `created_at`
- Un seul review par buyer (clé unique `offer_id + reviewer_user_id`)

### Table `bets`
- `creator_user_id`
- `group_id` (NULL = public)
- `title`, `description`, `details`
- `bet_type` (`boolean`, `number`, `multiple`)
- `closes_at`, `status` (`open`, `closed`, `cancelled`, `resolving`, `resolved`), `result_option_id`
- `resolved_at`, `created_at`, `updated_at`

### Table `bet_options`
- `bet_id`, `label`, `numeric_value`, `current_odds`

### Table `bet_positions`
- `bet_id`, `bet_option_id`, `user_id`
- `stake_points`, `odds_at_purchase`
- `status` (`open`, `sold`, `settled`, `cancelled`)
- `payout_points`, `sold_points`, `sold_at`, `settled_at`, `cancelled_at`

### Table `auth_secrets`
- `secret`, `is_primary`, `expires_at`, `created_at`

### Table `refresh_tokens`
- `user_id`, `token_hash`, `expires_at`, `revoked_at`, `last_used_at`, `created_at`

### Table `payout_jobs`
- `bet_id`, `result_option_id`, `resolved_by`
- `payload` (JSON)
- `status` (`queued`, `processing`, `completed`, `failed`)
- `error_message`, `attempts`, `started_at`, `completed_at`, `created_at`, `updated_at`

### Table `idempotency_keys`
- `idem_key`, `user_id`, `route`, `method`, `request_hash`
- `status`, `response_status`, `response_body`, `created_at`, `completed_at`

### Table `audit_logs`
Append-only (aucun endpoint de suppression).
- `actor_user_id`, `target_user_id`
- `action`, `reason`
- `points_delta`, `points_before`, `points_after`
- `related_entity_type`, `related_entity_id`
- `metadata` (JSON)
- `created_at`

### Contraintes points
- `CHECK(points >= 0)` + triggers `INSERT/UPDATE` pour empêcher des points négatifs.

---

## 4) Auth, rôles & sécurité

### JWT + refresh
- **Access token JWT** (gateway) : durée **1h**.
- **Refresh token** : stocké hashé en DB, **rotated** à chaque refresh.
- **Rotation de secret** : endpoint admin dédié (gateway) => ancien secret reste valide pendant une période de grâce.

### Rôles
- **Super admin** :
  - déterminé via `ADMIN_BOOTSTRAP_EMAIL` ou `ADMIN_BOOTSTRAP_USER_ID`
  - **ne peut pas être banni**
  - **ne peut pas être démoté**
  - ses paris/offres sont **intouchables** par les admins non-super
- **Admins** :
  - actions admin classiques
  - **ne peuvent pas bannir un admin**
  - **ne peuvent pas promouvoir/démoter** (réservé super admin)
- **Bannis** :
  - ne peuvent pas se connecter
  - toutes les requêtes authentifiées sont refusées
  - leurs points sont transférés au super admin lors du ban

### RBAC (permissions)
- Les checks passent par `roles`/`permissions` (ex: `admin.access`, `admin.super`).
- `is_admin` / `is_super_admin` restent **legacy** pour compatibilité, mais la logique métier s’appuie sur RBAC.

### Détection d’appareils
- Empreinte d’appareil (`user_devices`) à la connexion/inscription.
- Audit `auth_new_device` si un device inédit est détecté.

### Profils & visibilité
- Un profil peut être **public** ou **privé**.
- Si `public` et qu’un `profile_alias` est défini, il remplace le nom dans la vue publique.

### Groupes privés
- Un utilisateur peut appartenir à **0..n** groupes privés.
- Les offres/paris avec `group_id` ne sont visibles que par les membres du groupe (ou admins/super admin).

### Rate limiting
- Limitation globale (gateway + api)
- Limitation renforcée sur endpoints sensibles (auth / admin)
- **Backoff exponentiel** sur les endpoints sensibles
- Clé combinant **IP + email** pour l’auth afin de réduire le bruteforce

### Idempotency keys
- Header `Idempotency-Key` supporté sur les endpoints **qui déplacent des points** (ex: accept offer, buy/sell bet, resolve/cancel bet).
- Évite le double spend en cas de retry client.

---

## 5) Points & frais (2%)

### Points initiaux
- À l’inscription : **1000 points**.

### Frais 2%
- **Offres** : l’acheteur paie `points_cost + fee`, le vendeur reçoit `points_cost`.
- **Pari gagné** : gain net = `grossPayout - fee`.
- **Cashout (sell)** : cashout net = `cashout - fee`.

### Destination des frais
- **Tous les frais** vont au **super admin**, et sont loggés (audit `fee_*`).

---

## 6) Audit / Logs

Le système loggue :
- Toutes les transactions de points (admin credit/debit, achat d’offre, cashout, gains, refunds, transfert de ban, points initiaux…)
- Toutes les actions admin et actions métier sensibles
- Connexion / déconnexion / refresh + **nouveaux devices**

Endpoint dédié : `GET /admin/logs`

---

# 7) Endpoints

## 7.1 Gateway (Auth + Proxy)

### POST `/auth/register`
**But :** Créer un compte.
- Body: `{ name, email, password }`
- Effets:
  - Crée un user (1000 points)
  - Si l’email correspond au bootstrap, l’utilisateur devient **super admin**
  - Retourne `token` (JWT) + `refreshToken` + `newDevice`
  - `user` inclut `roles` + `permissions`
  - Log audit `auth_register`, points initiaux + `auth_new_device` si device inédit
- Restriction: publique

### POST `/auth/login`
**But :** Se connecter.
- Body: `{ email, password }`
- Effets:
  - Vérifie hash
  - Bloque si user banni
  - Retourne `token` + `refreshToken` + `newDevice`
  - `user` inclut `roles` + `permissions`
  - Log audit `auth_login` (+ `auth_new_device` si device inédit)
- Restriction: publique

### POST `/auth/refresh`
**But :** Renouveler le token.
- Body: `{ refreshToken }`
- Effets:
  - Vérifie + **rotate** le refresh token
  - Retourne `token` + `refreshToken` (nouveau)
  - Log audit `auth_refresh`
- Restriction: publique (rate-limited + backoff)

### POST `/auth/logout`
**But :** Déconnexion logique.
- Header: `Authorization: Bearer <token>`
- Body optionnel: `{ refreshToken }` (révoqué si présent)
- Effets:
  - Log audit `auth_logout`
- Restriction: authentifié

### POST `/admin/auth/rotate-secret`
**But :** Rotation des secrets JWT.
- Body: `{ newSecret?, graceHours? }`
- Effets:
  - Crée un nouveau secret primaire
  - Ancien secret actif pour `graceHours` (défaut 24)
  - Log audit `auth_rotate_secret`
- Restriction: **super admin**

### Proxy
- `/api/*` -> API métier
- `/ws/*` -> API WS

---

## 7.2 API métier (REST)

### Auth (middleware)
Toutes les routes sensibles exigent:
- `Authorization: Bearer <JWT>`
- User **non banni**

---

### System

#### GET `/health`
**But :** Health check.
- Restriction: publique

#### GET `/odds`
**But :** Dernier snapshot des cotes.
- Restriction: publique

#### GET `/absurde`
**But :** Endpoint stub (placeholder).
- Restriction: publique

#### GET `/openapi.json`
**But :** Spéc OpenAPI générée automatiquement.
- Restriction: publique

#### GET `/docs`
**But :** Swagger UI (OpenAPI).
- Restriction: publique

---

### Users (admin)

#### GET `/admin/users`
**But :** Liste des utilisateurs.
- Query: `limit`, `offset`, `sort`, `order`, `search`
- Restriction: admin ou super admin
- Log: `admin_list_users`

#### GET `/admin/users/banned`
**But :** Liste des utilisateurs bannis.
- Query: `limit`, `offset`, `sort`, `order`, `search`
- Restriction: admin ou super admin
- Log: `admin_list_banned`

#### GET `/admin/users/:id/logs`
**But :** Audit logs ciblés.
- Query: `limit`, `offset`, `scope`, `sort`, `order`, `action`, `search`
- Restriction: admin ou super admin

#### POST `/admin/users/:id/unban`
**But :** Débannir un user.
- Restriction: admin ou super admin
- Log: `admin_unban`

#### POST `/admin/users/:id/ban`
**But :** Bannir un user (non-admin uniquement).
- Effets :
  - Transfert de points au super admin
  - User => `is_banned=1`
  - Log `admin_ban` + logs points
- Restriction: admin ou super admin
 - Idempotency-Key supporté

#### POST `/admin/users/:id/points/credit`
**But :** Créditer points.
- Body: `{ amount }`
- Restriction: admin ou super admin
- Log: `admin_points_credit`
 - Idempotency-Key supporté

#### POST `/admin/users/:id/points/debit`
**But :** Débiter points.
- Body: `{ amount }`
- Restriction: admin ou super admin
- Log: `admin_points_debit`
 - Idempotency-Key supporté

#### POST `/admin/users/:id/promote`
**But :** Promouvoir en admin.
- Restriction: **super admin uniquement**
- Log: `admin_promote`

#### POST `/admin/users/:id/demote`
**But :** Démotion admin.
- Restriction: **super admin uniquement**
- Log: `admin_demote`

#### POST `/admin/users/:id/reset-password`
**But :** Reset le mot de passe.
- Body: `{ newPassword }`
- Effets: révoque tous les refresh tokens
- Restriction: admin ou super admin
- Log: `admin_reset_password`

#### GET `/users/:id`
**But :** Infos user (points, etc.).
- Restriction: utilisateur lui-même ou admin

---

### Profils & self

#### PATCH `/me/profile`
**But :** Mettre à jour le profil.
- Body possible: `{ description?, quote?, alias?, visibility? }`
- `visibility`: `public` ou `private`
- Restriction: authentifié
- Log: `profile_update`

#### GET `/profiles/:id`
**But :** Voir un profil public.
- Si profil `private`: visible uniquement par admin/super admin ou l’utilisateur lui-même.
- Restriction: publique (optionnellement authentifié)

#### GET `/me/stats`
**But :** Stats personnelles (paris, offers, net).
- Restriction: authentifié

#### GET `/me/bets`
**But :** Liste des paris créés ou joués par l’utilisateur.
- Restriction: authentifié

#### GET `/me/groups`
**But :** Groupes auxquels appartient l’utilisateur.
- Restriction: authentifié

---

### Groups (admin)

#### POST `/admin/groups`
**But :** Créer un groupe privé.
- Body: `{ name, description?, isPrivate? }`
- Restriction: admin ou super admin

#### PATCH `/admin/groups/:id`
**But :** Modifier un groupe.
- Body: `{ name?, description?, isPrivate? }`
- Restriction: admin ou super admin

#### GET `/admin/groups`
**But :** Liste des groupes.
- Query: `limit`, `offset`, `sort`, `order`, `search`
- Restriction: admin ou super admin

#### GET `/admin/groups/:id/members`
**But :** Liste des membres d’un groupe.
- Query: `limit`, `offset`, `sort`, `order`, `search`
- Restriction: admin ou super admin

#### POST `/admin/groups/:id/members`
**But :** Ajouter un membre.
- Body: `{ userId, role? }`
- Restriction: admin ou super admin

#### POST `/admin/groups/:id/members/batch`
**But :** Ajouter plusieurs membres d’un coup.
- Body: `{ userIds?: number[], users?: number[], role? }`
- Restriction: admin ou super admin

#### DELETE `/admin/groups/:id/members/:userId`
**But :** Retirer un membre.
- Restriction: admin ou super admin

---

### Offers (marketplace)

#### POST `/offers`
**But :** Créer une offre.
- Body: `{ title, description, pointsCost, maxAcceptances, groupId? }`
- `maxAcceptances` null/absent = infini
- `groupId` optionnel pour une offre privée
- Restriction: authentifié
- Log: `offer_create`

#### GET `/offers`
**But :** Lister les offres.
- Query: `active`, `limit`, `offset`, `sort`, `order`, `search`
- Restriction: publique
- Note: ne retourne que les offres publiques si non authentifié

#### GET `/offers/:id`
**But :** Détail offre.
- Restriction: publique (si offre privée, membres/admin uniquement)

#### POST `/offers/:id/accept`
**But :** Accepter / acheter un service.
- Restriction: authentifié
- Effets:
  - Débit acheteur (points + fee)
  - Crédit créateur (points_cost)
  - Fee au super admin
  - Log audit + points
 - Idempotency-Key supporté

#### GET `/offers/:id/acceptances`
**But :** Voir acceptations.
- Restriction: publique

#### GET `/offers/:id/reviews`
**But :** Voir reviews.
- Query: `limit`, `offset`
- Restriction: publique

#### POST `/offers/:id/reviews`
**But :** Laisser un review.
- Body: `{ rating, comment? }`
- Restriction: authentifié + avoir acheté l’offre
- Un seul review par user/offer

#### PATCH `/admin/offers/:id`
**But :** Modifier une offre.
- Body possible: `{ title, description, pointsCost, maxAcceptances, isActive }`
- `isActive=false` sert à mettre en pause, `isActive=true` à réactiver.
- Restriction: admin ou super admin
- **Interdit si offre du super admin (pour admin non-super)**
- Log: `offer_update`

#### DELETE `/admin/offers/:id`
**But :** Supprimer définitivement une offre.
- Restriction: admin ou super admin
- **Interdit si offre du super admin (pour admin non-super)**
- Log: `offer_delete`

---

### Bets (paris)

#### POST `/bets`
**But :** Créer un pari.
- Body: `{ title, description, details, closesAt, betType, options, groupId? }`
- `details` = description détaillée des conditions de gain/perte
- `options` min 2. Ex:
  ```json
  { "label": "Oui", "odds": 1.9 }
  ```
- `groupId` optionnel pour un pari privé
- Restriction: authentifié
- Log: `bet_create`

#### GET `/bets`
**But :** Lister paris.
- Query: `active`, `limit`, `offset`, `sort`, `order`, `search`
- Restriction: publique
- Note: ne retourne que les paris publics si non authentifié

#### GET `/bets/:id`
**But :** Détail pari.
- Restriction: publique (si pari privé, membres/admin uniquement)

#### POST `/bets/:id/buy`
**But :** Acheter une position.
- Body: `{ optionId, stakePoints }`
- Restriction: authentifié
- Log: `bet_buy` + points debit
 - Idempotency-Key supporté

#### POST `/bets/:id/sell`
**But :** Vendre une position (cashout).
- Body: `{ positionId }`
- Restriction: authentifié
- Effets:
  - Crédit net (fee déduite)
  - Fee vers super admin
  - Log `bet_sell`
 - Idempotency-Key supporté

#### GET `/bets/:id/positions`
**But :** Lister positions de l’utilisateur connecté.
- Query: `limit`, `offset`, `sort`, `order`
- Restriction: authentifié

#### GET `/admin/bets/pending-resolution`
**But :** Liste des paris clos sans résultat.
- Query: `limit`, `offset`
- Restriction: admin ou super admin

#### POST `/admin/bets/:id/resolve`
**But :** Résoudre un pari (enqueue).
- Body: `{ resultOptionId }`
- Effets:
  - Passe le bet en `resolving`
  - Crée un job `payout_jobs`
  - Le worker calcule payouts + fees + log `bet_resolve`
- Retourne `jobId`
- Restriction: admin ou super admin
- **Interdit sur bet du super admin si admin non-super**
 - Idempotency-Key supporté

#### PATCH `/admin/bets/:id`
**But :** Modifier un pari.
- Body possible: `{ title, description, details, closesAt, status }`
- Restriction: admin ou super admin
- **Interdit sur bet du super admin si admin non-super**

#### POST `/admin/bets/:id/options`
**But :** Ajouter une option.
- Body: `{ label, odds, value? }`
- Restriction: admin ou super admin
- **Interdit si positions existent**
- **Interdit sur bet du super admin si admin non-super**

#### PATCH `/admin/bets/:betId/options/:optionId`
**But :** Modifier une option (label/odds/value).
- Body: `{ label?, odds?, value? }`
- Restriction: admin ou super admin
- **Si positions existent : seules les cotes peuvent être modifiées**
- **Interdit sur bet du super admin si admin non-super**

#### DELETE `/admin/bets/:betId/options/:optionId`
**But :** Supprimer une option.
- Restriction: admin ou super admin
- **Interdit si positions existent**
- **Interdit si moins de 2 options restantes**
- **Interdit sur bet du super admin si admin non-super**

#### DELETE `/admin/bets/:id`
**But :** Annuler un pari.
- Effets:
  - Remboursement positions ouvertes
  - Log `bet_cancel`
- Restriction: admin ou super admin
- **Interdit sur bet du super admin si admin non-super**
 - Idempotency-Key supporté

---

### Logs & finance

#### GET `/admin/logs`
**But :** Consulter l’audit.
- Query: `limit`, `offset`, `sort`, `order`, `action`, `search`, `actorUserId`, `targetUserId`, `relatedEntityType`, `relatedEntityId`
- Restriction: admin ou super admin
- Log: `admin_list_logs`

#### GET `/admin/fees/summary`
**But :** Résumé des fees collectées.
- Query: `from`, `to` (dates ISO)
- Restriction: admin ou super admin
- Log: `admin_fee_summary`

---
