# Optional warm snapshot: build/publish this image and create a Daytona snapshot.
# Pin a Playwright version so the package and bundled Chromium always match.
FROM mcr.microsoft.com/playwright:v1.58.2-noble
RUN apt-get update && apt-get install -y --no-install-recommends python3 python3-pip python3-venv postgresql postgresql-client sqlite3 git curl ca-certificates sudo && rm -rf /var/lib/apt/lists/*
RUN useradd -m -s /bin/bash daytona && echo 'daytona ALL=(ALL) NOPASSWD:ALL' > /etc/sudoers.d/daytona
ENV PLAYWRIGHT_BROWSERS_PATH=/ms-playwright
USER daytona
WORKDIR /home/daytona
RUN mkdir -p playground/system && cd playground/system && npm init -y && npm install --save-exact playwright@1.58.2
