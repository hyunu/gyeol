FROM node:24-alpine AS build
WORKDIR /repo
# 앱 소스 복사
COPY apps/algo-verify/package.json apps/algo-verify/package-lock.json* ./apps/algo-verify/
WORKDIR /repo/apps/algo-verify
RUN npm ci 2>/dev/null || npm install
COPY apps/algo-verify ./
# 데모 샘플(원본)을 정적 자산으로 포함
RUN mkdir -p public/samples
COPY demo/audio-samples/*.wav ./public/samples/
RUN npm run build

FROM nginx:1.27-alpine
COPY deploy/n100/algo-verify/nginx.conf /etc/nginx/conf.d/default.conf
COPY --from=build /repo/apps/algo-verify/dist /usr/share/nginx/html
EXPOSE 80
