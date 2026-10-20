FROM golang:1.27.2-alpine AS build
WORKDIR /src
COPY go.mod go.sum ./
RUN go mod download
COPY . .
RUN CGO_ENABLED=0 go build -trimpath -ldflags='-s -w' -o /out/librebrowser ./cmd/librebrowser
FROM alpine:3.23
RUN apk add --no-cache ca-certificates tzdata && addgroup -g 10001 libre && adduser -D -u 10001 -G libre libre && mkdir -p /data /run/librebrowser && chown libre:libre /data /run/librebrowser && chmod 0700 /data && chmod 0770 /run/librebrowser
RUN mkdir -p /run/librebrowser-uplink && chown 65532:65532 /run/librebrowser-uplink && chmod 0700 /run/librebrowser-uplink
COPY --from=build /out/librebrowser /usr/local/bin/librebrowser
USER 10001:10001
ENTRYPOINT ["librebrowser"]
CMD ["serve"]
