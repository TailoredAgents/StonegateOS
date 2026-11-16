// Temporary Render edge-header rehearsal. It can only reach the isolated
// Cloudflare transport fixture and always requires a separate ingress key.
import { createForwarder } from "./server.mjs";
const token = process.env.STONEGATE_FORWARDER_TOKEN;
const ingressToken = process.env.STONEGATE_INGRESS_TEST_TOKEN;
const expiresAt = Date.parse(process.env.STONEGATE_INGRESS_EXPIRES_AT ?? "");
if (
  !ingressToken ||
  ingressToken.length < 32 ||
  !(expiresAt > Date.now()) ||
  expiresAt > Date.now() + 24 * 3600000
)
  throw Error("INVALID_INGRESS_REHEARSAL_CONFIGURATION");
const instance = createForwarder({
  target: "https://stonegate-http-gateway-validation.jeffrey-78e.workers.dev",
  token,
  ingressToken,
  clientIpHeader: "cf-connecting-ip",
});
const port = Number(process.env.PORT ?? 10000);
if (!Number.isInteger(port) || port < 1024 || port > 65535)
  throw Error("INVALID_PORT");
instance.server.listen(port, "0.0.0.0");
const stop = () =>
  void instance.drain().then(({ forced }) => process.exit(forced ? 1 : 0));
process.once("SIGTERM", stop);
process.once("SIGINT", stop);
setTimeout(stop, expiresAt - Date.now()).unref();
