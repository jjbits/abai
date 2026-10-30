# The arena server with everything it spawns: the ornithopter program and the
# arena itself; the abai packages come from npm.
FROM node:22-bookworm-slim

WORKDIR /app
ENV NODE_ENV=production

# the two example packages; the arena links the game by its file: path
COPY examples/ornithopter ./examples/ornithopter
COPY examples/ornithopter-arena ./examples/ornithopter-arena
RUN cd examples/ornithopter && npm ci --no-audit --no-fund --omit=dev \
	&& cd ../ornithopter-arena && npm ci --no-audit --no-fund --omit=dev

# an unprivileged user, a writable /tmp only (the compose file mounts it), nothing listening but the arena
USER node
ENV ARENA_HOST=0.0.0.0 \
	ARENA_PORT=8093 \
	ARENA_RUN_ROOT=/tmp/orni \
	HOME=/tmp/orni
EXPOSE 8093
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
	CMD node -e "fetch('http://127.0.0.1:8093/world').then((r) => process.exit(r.ok ? 0 : 1), () => process.exit(1))"
CMD ["node", "examples/ornithopter-arena/src/main.ts"]
