// Paiement automatique CinetPay (Wave, Orange Money, MTN, Moov, carte).
// S'active dès que CINETPAY_APIKEY, CINETPAY_SITE_ID et PUBLIC_API_URL sont renseignés dans .env.
// Le statut d'un paiement est TOUJOURS revérifié auprès de CinetPay (jamais cru sur parole).
const API = "https://api-checkout.cinetpay.com/v2";

const config = () => ({
  apikey: process.env.CINETPAY_APIKEY || "",
  siteId: process.env.CINETPAY_SITE_ID || "",
  publicUrl: (process.env.PUBLIC_API_URL || "").replace(/\/+$/, ""),
});

const isConfigured = () => {
  const c = config();
  return !!(c.apikey && c.siteId && /^https:\/\//.test(c.publicUrl));
};

async function post(path, body) {
  const res = await fetch(`${API}${path}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(15000),
  });
  return res.json();
}

// Crée une session de paiement ; renvoie l'URL à ouvrir.
async function initPayment({ transactionId, amount, description, customer }) {
  const c = config();
  const data = await post("/payment", {
    apikey: c.apikey,
    site_id: c.siteId,
    transaction_id: transactionId,
    amount,
    currency: "XOF",
    description,
    notify_url: `${c.publicUrl}/api/payments/cinetpay/notify`,
    return_url: `${c.publicUrl}/api/payments/cinetpay/return`,
    channels: "ALL",
    lang: "fr",
    customer_name: customer?.lastName || "",
    customer_surname: customer?.firstName || "",
  });
  if (data?.code !== "201" || !data?.data?.payment_url) {
    const err = new Error(`CinetPay : ${data?.message || "initialisation refusée"}`);
    err.gateway = data;
    throw err;
  }
  return { paymentUrl: data.data.payment_url };
}

// Statut réel d'une transaction : { accepted, amount, currency, status }.
async function checkPayment(transactionId) {
  const c = config();
  const data = await post("/payment/check", { apikey: c.apikey, site_id: c.siteId, transaction_id: transactionId });
  const d = data?.data || {};
  return {
    accepted: data?.code === "00" && d.status === "ACCEPTED",
    status: d.status || data?.message || "UNKNOWN",
    amount: Number(d.amount) || 0,
    currency: d.currency || null,
  };
}

module.exports = { isConfigured, initPayment, checkPayment, config };
