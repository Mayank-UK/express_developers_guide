/**
 * Teaching exhibit (deployment topic — "TLS termination at the proxy").
 *
 * The TLS-evolved shape of the nginx conf the proxy section quotes
 * (.docker/client/default.conf — the REAL shipped conf, which terminates no
 * TLS because the guide's own certificates are dev-only). Real certificates
 * never live in a repo, so the TLS variant is pinned HERE as a teaching
 * exhibit: same forwarding contract (X-Real-IP / X-Forwarded-For /
 * X-Forwarded-Proto → trust proxy), plus the redirect server and the ACME
 * friendly port-80 block.
 *
 * The cert paths are the letsencrypt/live convention; guide.example.test is
 * the guide's stand-in domain. Everything else is production-shaped nginx:
 * HSTS added at the proxy for what helmet cannot reach (static files), http2
 * switched on with its own directive (the listen-flag form is deprecated),
 * and plain http existing only to redirect.
 */
export const TLS_TERMINATION_CONF = `
server {
    listen 443 ssl;
    listen [::]:443 ssl;
    http2 on;
    server_name guide.example.test;

    ssl_certificate     /etc/letsencrypt/live/guide.example.test/fullchain.pem;
    ssl_certificate_key /etc/letsencrypt/live/guide.example.test/privkey.pem;

    # helmet already sends HSTS on API responses; nginx adds it to everything
    # else this server block touches (static files included).
    add_header Strict-Transport-Security "max-age=31536000; includeSubDomains" always;

    root  /usr/share/nginx/html;
    index index.html;

    location /api/ {
        proxy_pass http://server:4000;
        proxy_http_version 1.1;
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection 'upgrade';
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
        proxy_cache_bypass $http_upgrade;
    }

    location / {
        try_files $uri $uri/ /index.html;
    }
}

# plain http exists only to redirect (and to answer ACME challenges):
server {
    listen 80;
    listen [::]:80;
    server_name guide.example.test;
    return 301 https://$host$request_uri;
}
`;
