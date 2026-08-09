FROM node:20-alpine

WORKDIR /app
COPY --chown=node:node server.mjs ./server.mjs

ENV HOST=0.0.0.0
ENV HTTP_PORT=4016
ENV SMTP_PORT=1025
EXPOSE 4016 1025

USER node
CMD ["node", "server.mjs"]
