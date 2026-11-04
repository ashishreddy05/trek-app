# Two-stage, non-root. HTTPS terminates at the platform edge.

FROM node:20-alpine AS deps
WORKDIR /app
COPY package.json ./
RUN npm install --omit=dev && npm cache clean --force

FROM node:20-alpine AS runtime
WORKDIR /app

# Never run as root.
RUN addgroup -S trek && adduser -S trek -G trek

COPY --from=deps --chown=trek:trek /app/node_modules ./node_modules
COPY --chown=trek:trek package.json ./
COPY --chown=trek:trek src ./src
COPY --chown=trek:trek migrations ./migrations
COPY --chown=trek:trek scripts ./scripts

# .env is never copied. Secrets arrive from the platform secret store as
# process environment variables at runtime.

USER trek
ENV NODE_ENV=production
EXPOSE 3000

# Liveness only — no dependencies, so the platform can tell "process up" from
# "process healthy". /readyz additionally checks DB + migration state.
HEALTHCHECK --interval=30s --timeout=3s --start-period=10s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||3000)+'/healthz').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

CMD ["node", "src/http/server.js"]
