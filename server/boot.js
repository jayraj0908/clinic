require("dotenv").config();

const jwt = require("jsonwebtoken");

const JWT_SIGN_OPTS = { algorithm: "HS256", expiresIn: "7d" };
const JWT_VERIFY_OPTS = { algorithms: ["HS256"] };

const origSign = jwt.sign;
jwt.sign = function patchedSign(payload, secret, options, callback) {
  if (typeof options === "function") {
    callback = options;
    options = undefined;
  }
  const opts = Object.assign({}, options || {}, JWT_SIGN_OPTS);
  if (typeof callback === "function") {
    return origSign.call(this, payload, secret, opts, callback);
  }
  return origSign.call(this, payload, secret, opts);
};

const origVerify = jwt.verify;
jwt.verify = function patchedVerify(token, secret, options, callback) {
  if (typeof options === "function") {
    callback = options;
    options = undefined;
  }
  const opts = Object.assign({}, options || {}, JWT_VERIFY_OPTS);
  if (typeof callback === "function") {
    return origVerify.call(this, token, secret, opts, callback);
  }
  return origVerify.call(this, token, secret, opts);
};

const NODE_ENV = process.env.NODE_ENV || "development";
if (NODE_ENV === "production" && !process.env.VAPI_SERVER_SECRET) {
  console.error(
    "Refusing to boot: NODE_ENV=production requires VAPI_SERVER_SECRET (same fail-closed idea as JWT_SECRET). META_APP_SECRET, GOOGLE_ADS_WEBHOOK_KEY, and RESEND_INBOUND_SECRET are not required to boot."
  );
  process.exit(1);
}

const origLog = console.log;
console.log = function patchedLog(...args) {
  if (typeof args[0] === "string" && args[0].startsWith("Clinic suite running")) {
    args[0] = args[0].replace("Clinic suite running", "Sailz running");
  }
  return origLog.apply(this, args);
};

require("./server.js");
