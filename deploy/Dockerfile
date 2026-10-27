FROM node:24-bookworm-slim

ARG VERSION=0.14.2
ARG VCS_REF=unknown
LABEL org.opencontainers.image.source="https://github.com/HotLL233/labmg" \
      org.opencontainers.image.version=$VERSION \
      org.opencontainers.image.revision=$VCS_REF

ENV NODE_ENV=production \
    PORT=3000 \
    LABOS_RUNTIME_DIR=/var/lib/labos

WORKDIR /app
COPY --chown=node:node package.json package-lock.json ./
RUN npm ci --omit=dev --ignore-scripts --no-audit --no-fund && npm cache clean --force
COPY --chown=node:node src ./src
COPY --chown=node:node migrations ./migrations
COPY --chown=node:node scripts/migrate.js ./scripts/migrate.js
COPY --chown=node:node docs/licenses ./docs/licenses
COPY --chown=node:node docs/THIRD_PARTY.md ./docs/THIRD_PARTY.md
RUN mkdir -p /var/lib/labos && chown node:node /var/lib/labos

USER node
EXPOSE 3000
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
    CMD ["node", "-e", "require('node:http').get('http://127.0.0.1:3000/api/auth/me',r=>{r.resume();process.exit(r.statusCode===200?0:1)}).on('error',()=>process.exit(1))"]

CMD ["node", "src/server.js"]
