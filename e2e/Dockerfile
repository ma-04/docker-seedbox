# Playwright runner for the hermetic e2e stack (build context: e2e/). The base image tag must equal the exact
# @playwright/test version in package.json (run.sh passes PW_VERSION).
ARG PW_VERSION=1.65.0
FROM mcr.microsoft.com/playwright:v${PW_VERSION}-noble
WORKDIR /e2e
COPY package.json ./
RUN npm install --no-audit --no-fund --no-package-lock
COPY . .
CMD ["npx", "playwright", "test"]
