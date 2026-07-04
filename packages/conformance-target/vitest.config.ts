import { cloudflareTest } from "@cloudflare/vitest-pool-workers";
import { defineConfig } from "vitest/config";

/** Throwaway RSA keypair for the ActivityPub actor under test. */
const AP_PUBLIC_PEM = `-----BEGIN PUBLIC KEY-----
MIIBIjANBgkqhkiG9w0BAQEFAAOCAQ8AMIIBCgKCAQEAyfrPaMG2hvVZ8E1yMZFO
dsD5kuKNq1pCUePObQMZB7rHr5tVI15GAt4hW2hdWaNcxjxiZo2TJxl3cEtdC4RS
8zMX1Pav34gC2kd49ioo76qfOU+Wl2VR9Ykw775c3fJcvHIEKRi34au1vPRW0Vp6
i5oGfz9LFmBcm0ry0QVb3NB6tpbzECFbtaJ29zX7Oqk2ck/stgBHJs8Q3wN+OjwQ
TaLSzMt5mNsmTWJIo9PEJ+eRIqSv6pF4XHMUYLceLL8+VyQrG42rRR07pQv4B9hQ
sYsBHcXWDVnopyyhD+/wry7dpAj/YRAPNKXjxjbSgwp3aX0xKP+yBNQ5enuA8tVb
OQIDAQAB
-----END PUBLIC KEY-----`;

const AP_PRIVATE_PEM = `-----BEGIN PRIVATE KEY-----
MIIEvQIBADANBgkqhkiG9w0BAQEFAASCBKcwggSjAgEAAoIBAQDJ+s9owbaG9Vnw
TXIxkU52wPmS4o2rWkJR485tAxkHusevm1UjXkYC3iFbaF1Zo1zGPGJmjZMnGXdw
S10LhFLzMxfU9q/fiALaR3j2Kijvqp85T5aXZVH1iTDvvlzd8ly8cgQpGLfhq7W8
9FbRWnqLmgZ/P0sWYFybSvLRBVvc0Hq2lvMQIVu1onb3Nfs6qTZyT+y2AEcmzxDf
A346PBBNotLMy3mY2yZNYkij08Qn55EipK/qkXhccxRgtx4svz5XJCsbjatFHTul
C/gH2FCxiwEdxdYNWeinLKEP7/CvLt2kCP9hEA80pePGNtKDCndpfTEo/7IE1Dl6
e4Dy1Vs5AgMBAAECggEAA0qfDqn5e4GMEapxbfVcPfsvFgGzJVO3OPZpasVeJw4Y
KvhxDr5+jZVpHcA5pThQTrq1L86m00BK/f18aq+hWm0+ui269/2TblMz2W8ec6lo
JtrxLU5tY3702TNU+Bj3AespvjG07WyK7aVdtNOwo43DBVfWtWqkl7NE+bsIoDSO
GtrzvwE7ZWbkw0/w1hYYlqV/HLuHnWnI0Zl3KgeFTlJOJ1jMWnl0drqA8fuhNSZO
PuRBZrwEEMPicW2KfDh87FDtviLzEKkq3O8fDTRgS/WvjXLXycfXy9Ko52fecMSD
Bveb0qostiiC8Cv8kkWvFXdqmp6Yv3G7IFmf1gLKAQKBgQD4I7g2yTzvjGBoE2aV
NMb+ORc+n6j1Gfl6sUZ5LeclIpBCMgpLu1+YgH9hxXG/cyqQ4L6zE4l2NtULJHLH
NKJgUgzLLvGJKTkmoLXTld+4LN+lqBgjtdPnU92aiGioMHYKF9YbN3QXb7+kVDOG
rpyNw85WEWfzZLbM41TfFkqGSQKBgQDQYMJOgSULpk/r2CLHVbhZmoT2a//8faMx
pvVn7QGphzXtNlToDAfLHqHIEgU1awb5QkH2XtdlrNIASqcd+kbHxlNJIxh9SduR
KEuZV0MFvbjlvA49N/iu8tcASA/zAlQzjXwM2JdSxoYa2NzEGOwmQV5Ms5bv/nEu
unJVPqttcQKBgHyd67jP7aNcO1ppS95pB/rKjyrrIf4d0lXUy9C1xdy3c/1ahiMs
ccDz34UplIuSefESfZMPn7xXozyaTG5Qt69p5XTxGWpJ4qLMmSQuo5EqMBNQzPa6
LTaCvssJ8I1u8Qj2mZdHjSzr+TG8+7eK36KukGRXD36DuO5CyO/UkQ7JAoGAR1vL
Tq0FLa8fkWlrx42AWxcCT4z+lc3ElB1Tzuon9pE6E2jWvLxZ8uIjjus0420qbzOU
eTVTWBtNsxHdlvN9R66QGOyu10Dyswv0j6eFaTLmXa3/xlEjlW3N2OfUpmh2w0zB
XXjSoWMgy5LWT0UloZgjHesmVjtxMQpiWvTiKdECgYEAwqfrhjqZF74OpKk78RSn
Kw5KFDZz4v5JfYvTbjs+9GPO4Ftb/pNP1X8bpA6hkE4mqqG7+vjAWgd2hjU3XLum
Az5N7HxMxBwO8D2zdaKL+/zoaE/12O7Vaa3ajp9uOx0xyavrzKr7m3l0sZOF2Ylc
S3IBQZi/trRtr2NQCd56ErE=
-----END PRIVATE KEY-----`;

/** Throwaway P-256 private JWK for the VC issuer under test. */
const VC_TEST_JWK =
  '{"key_ops":["sign"],"ext":true,"kty":"EC","x":"nvmZzosnCfbDtHP4EqM-Ngov1eop7f1PUQ-VDqWvnjU","y":"TOzo9pz77WoetLKq-DrRvenfwTn7zj-3BDk78NeJOIE","crv":"P-256","d":"fxkNMS4pKeXfLMd-zeboOFlRorzHjPW3WcHAzcHrBiM"}';

export default defineConfig({
  // N3.js (via @dwk/solid-pod → @dwk/rdf) depends on `readable-stream`; map it
  // to workerd's native Node stream, same as packages/solid-pod/vitest.config.ts.
  resolve: {
    alias: {
      "readable-stream": "node:stream",
    },
  },
  plugins: [
    cloudflareTest({
      main: "./src/test-harness.ts",
      miniflare: {
        compatibilityDate: "2025-01-01",
        compatibilityFlags: ["nodejs_compat"],
        durableObjects: {
          POD: { className: "SolidPodObject", useSQLite: true },
          STORAGE: { className: "RemoteStorageObject", useSQLite: true },
          ACTOR: { className: "ActivityPubObject", useSQLite: true },
          WEBAUTHN: { className: "WebAuthnObject", useSQLite: true },
          REPO: { className: "AtprotoRepoObject", useSQLite: true },
        },
        r2Buckets: ["BLOBS", "MEDIA"],
        d1Databases: [
          "AUTH_DB",
          "MICROPUB_DB",
          "MICROSUB_DB",
          "WEBSUB_DB",
          "WEBMENTION_INBOX",
          "GC_DB",
        ],
        queueProducers: {
          WEBMENTION_QUEUE: { queueName: "conformance-webmention" },
          WEBSUB_QUEUE: { queueName: "conformance-websub" },
          MICROSUB_QUEUE: { queueName: "conformance-microsub" },
        },
        bindings: {
          BASE_URL: "https://conformance.test",
          TOKEN_SIGNING_KEY: "conformance-test-token-signing-key",
          CONFORMANCE_PASSWORD: "conformance-test-password",
          CONFORMANCE_ADMIN_TOKEN: "conformance-test-admin-token",
          ACTIVITYPUB_PUBLIC_KEY_PEM: AP_PUBLIC_PEM,
          ACTIVITYPUB_PRIVATE_KEY_PEM: AP_PRIVATE_PEM,
          VC_SIGNING_KEY: VC_TEST_JWK,
          ATPROTO_PASSWORD: "conformance-test-atproto-password",
          ATPROTO_JWT_SECRET: "conformance-test-atproto-jwt-secret",
        },
      },
    }),
  ],
  test: {
    name: "@dwk/conformance-target",
  },
});
