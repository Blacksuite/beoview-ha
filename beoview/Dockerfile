FROM alexxit/go2rtc:1.9.10 AS go2rtc
FROM oven/bun:1.4.4-alpine
RUN apk add --no-cache ffmpeg
COPY --from=go2rtc /usr/local/bin/go2rtc /usr/local/bin/go2rtc
WORKDIR /app
COPY package.json bun.lock ./
RUN bun install --frozen-lockfile --production
COPY bridge.ts beoview-cloud-ca.pem idle.jpg go2rtc.yaml setup.html ./
COPY card ./card
COPY replies ./replies
ENV GO2RTC_CONFIG=/app/go2rtc.yaml
CMD ["bun", "bridge.ts"]
