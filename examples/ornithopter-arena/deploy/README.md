# Deploying the arena

The arena runs as one container on a Docker host behind a reverse proxy
that terminates TLS. These are the steps for Joon's Hetzner box, where
the host Caddy owns ports 80 and 443 and every container port binds to
the loopback address. Nothing here touches the other stacks on the box.

## Once

1. DNS: an A record `ornithopter.gearedagents.com` to the box, DNS-only.
2. On the box, a home for the stack: `mkdir -p /srv/ornithopter`.

## Each deploy

From the Mac, in the repository root:

```
rsync -a --delete --exclude node_modules --exclude dist --exclude .git \
	./ hetzner-direct:/srv/ornithopter/src/
ssh hetzner-direct 'cd /srv/ornithopter && docker compose -f src/examples/ornithopter-arena/deploy/docker-compose.yml up -d --build'
```

The first deploy also installs the vhost:

```
ssh hetzner-direct 'cp /srv/ornithopter/src/examples/ornithopter-arena/deploy/ornithopter.caddy /etc/caddy/sites/ && systemctl reload caddy'
```

## Check

```
ssh hetzner-direct 'docker compose -f /srv/ornithopter/src/examples/ornithopter-arena/deploy/docker-compose.yml ps && docker logs --tail 5 ornithopter-arena'
curl -s https://ornithopter.gearedagents.com/world | head -c 200
curl -s -X POST -H 'x-arena: fly' https://ornithopter.gearedagents.com/fly
```

The last prints a session: a callsign, the MCP address, and the commands
for Claude Code and Codex. Then from any machine:

```
claude mcp add --transport http ornithopter <that MCP address>
claude
> Read abai_prompt and fly.
```

## Limits and knobs

Every limit is an environment variable in the compose file: live sessions
(18, also the spawn slots), sessions per address (3), creations per minute
per address (5), idle (10 min), lifetime (3 h), wreck (10 min). The
container runs read-only as the `node` user with every capability
dropped, a 256 MB tmpfs for sessions' sockets and audit logs, 512
processes, 4 GB and 4 CPUs. A session is two Node processes of about
60 MB each.

## Rollback

`docker compose -f ... down` stops it; the previous image is gone once a
new one is built, so a rollback is a rebuild from the previous commit.
Nothing persists: every session is lost on a restart, by design.
