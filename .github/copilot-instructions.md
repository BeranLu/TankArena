# Tank Arena Copilot Instructions

- Project: local-network multiplayer browser game.
- Stack: Express, Socket.IO, React, Vite, TypeScript.
- Server role: authoritative game state, lobby flow, late-join observers, admin control.
- Client role: player join flow, lobby, admin console, arena rendering, keyboard and mouse input.
- Keep changes small and focused on gameplay, networking, or UI flow.
- Preserve support for deathmatch, capture the flag, and protect the king.
- Keep the server bound to `0.0.0.0` for LAN play.
- Prefer simple, maintainable code over speculative abstraction.
