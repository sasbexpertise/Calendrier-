# Calendrier RDV

Prise de rendez-vous partagée : vous ouvrez des créneaux, le client en choisit un, vous validez.

## Lancer
```bash
ADMIN_PASSWORD="votre-mot-de-passe" npm start
```
- Page client (le lien à envoyer) : `http://localhost:3000/`
- Administration : `http://localhost:3000/admin`

Aucune dépendance : Node.js 18+ suffit. Les données sont dans `data/db.json` (sauvegardez ce fichier).
Variables : `ADMIN_PASSWORD`, `PORT` (3000), `DATA_DIR` (`./data`).

## Fonctionnement
1. **Réglages** : titre, liens visio / Teams, adresse pour le présentiel.
2. **Créneaux** : choisissez la période (2-3 semaines), les jours, les horaires, la durée, la pause déjeuner et les modes proposés.
3. Envoyez le lien aux clients. Ils choisissent un créneau libre + un mode (visio, Teams, présentiel) et laissent leurs coordonnées.
4. **Demandes** : vous acceptez (en pouvant changer le mode) ou refusez. Un refus rouvre le créneau.
5. Le client suit sa demande via un lien privé et peut ajouter le RDV confirmé à son agenda (.ics). Il reçoit le lien de visio/Teams ou l'adresse une fois confirmé.

## Tests
`npm test`

## Mise en ligne
Pour que vos clients y accèdent, hébergez-le sur un serveur Node (Render, Railway, Fly.io, VPS…) derrière HTTPS, avec un disque persistant pour `DATA_DIR`.
