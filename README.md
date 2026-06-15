# Memory

Memory game webapp with a single game stream, a TV view, a tablet submit page, seeded games, and SQLite persistence.

## Run

```bash
npm install
npm start
```

Open:

- `http://localhost:3000/`
- `http://localhost:3000/tv`
- `http://localhost:3000/tablet`

## Docker

1. Copy `.env.example` to `.env` and edit it for the instance you want to run.
2. Start the container:

```bash
docker compose up --build
```

Relevant env values:

- `THEME=HORDE` or `THEME=ALLIANCE`
- `HOST_PORT` for the exposed host port
- `APP_PORT` for the port the Node process listens on inside the container
- `DB_PATH` for the SQLite file path inside the container

## Behavior

- Shows 200 seeded random French words for 60 seconds.
- After 60 seconds, the board blurs heavily.
- Correct guesses unblur individual words on the TV.
- Tablet submit page accepts guesses for 5 minutes.
- A game allows up to 250 tries.
- Each game stores its seed so the exact setup can be reproduced.
- Each game and each guess is stored in `piscine-games.sqlite`.
