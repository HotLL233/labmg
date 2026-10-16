FROM node:24-bookworm-slim

ARG VERSION=0.2.0-rc.4
ARG VCS_REF=unknown
LABEL org.opencontainers.image.source="https://github.com/HotLL233/labmg" \
      org.opencontainers.image.version=$VERSION \
      org.opencontainers.image.revision=$VCS_REF

ENV NODE_ENV=production \
    PORT=3000 \
    LABOS_RUNTIME_DIR=/var/lib/labos

WORKDIR /app
COPY --chown=node:node package.json ./
COPY --chown=node:node src ./src
RUN mkdir -p /var/lib/labos && chown node:node /var/lib/labos

USER node
EXPOSE 3000
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
    CMD ["node", "-e", "require('node:http').get('http://127.0.0.1:3000/api/auth/me',r=>{r.resume();process.exit(r.statusCode===200?0:1)}).on('error',()=>process.exit(1))"]

CMD ["node", "src/server.js"]
