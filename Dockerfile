FROM node:26-bookworm@sha256:465292e747f0124f074dc7d6e79dd38141d132d53d076b3ef0e0a43eea019e80

WORKDIR /repro

COPY package.json package-lock.json ./
RUN npm ci

COPY child.mjs repro.mjs ./

CMD ["node", "repro.mjs", "16", "50"]
