FROM node:20-alpine

WORKDIR /app
COPY --chown=node:node server.mjs ./server.mjs

ENV HOST=0.0.0.0
ENV PORT=4015
EXPOSE 4015

USER node
CMD ["node", "server.mjs"]
