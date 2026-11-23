const mongoose = require("mongoose");

// Facture ISD : frais de mise en relation payés une seule fois par la famille.
const invoiceSchema = new mongoose.Schema(
  {
    offerId: { type: mongoose.Schema.Types.ObjectId, ref: "Offer", required: true, unique: true },
    family: { type: mongoose.Schema.Types.ObjectId, ref: "User", required: true },
    provider: { type: mongoose.Schema.Types.ObjectId, ref: "User", required: true },
    reference: { type: String, required: true, unique: true },

    // Calcul du montant (figé à la création)
    breakdown: {
      agreedPrice: { type: Number, default: 0 },
      unit: { type: String, default: "month" },
      monthlyEstimate: { type: Number, default: 0 },
      rate: { type: Number, default: 0 },
      kind: { type: String, enum: ["percent", "flat", "waived"], default: "percent" },
      baseFee: { type: Number, default: 0 },
      discount: { type: Number, default: 0 },
      discountLabel: { type: String, default: null },
    },
    amount: { type: Number, required: true },
    currency: { type: String, default: "XOF" },
    startDate: { type: Date, default: null },

    // pending : à payer · submitted : paiement déclaré, en vérification ·
    // paid : réglée · rejected : déclaration refusée (à refaire) · waived : offerte (garantie)
    status: { type: String, enum: ["pending", "submitted", "paid", "rejected", "waived", "cancelled"], default: "pending" },
    method: { type: String, enum: ["manual", "cinetpay", "waived", null], default: null },

    // Paiement manuel : déclaration de la famille, vérification par un administrateur
    declaration: {
      operator: { type: String, enum: ["wave", "orange", "mtn", "moov", null], default: null },
      transactionRef: { type: String, default: null },
      at: { type: Date, default: null },
    },
    declarationCount: { type: Number, default: 0 },
    verifiedBy: { type: mongoose.Schema.Types.ObjectId, ref: "User", default: null },
    verifiedAt: { type: Date, default: null },
    rejectReason: { type: String, default: null },

    // Paiement automatique (CinetPay)
    gateway: {
      transactionId: { type: String, default: null },
      paymentUrl: { type: String, default: null },
      status: { type: String, default: null },
    },

    paidAt: { type: Date, default: null },

    // Garantie de remplacement
    guaranteeUntil: { type: Date, default: null },
    guaranteeUsedAt: { type: Date, default: null },
    replacementOfferId: { type: mongoose.Schema.Types.ObjectId, ref: "Offer", default: null },
  },
  { timestamps: true, optimisticConcurrency: true }
);
invoiceSchema.index({ status: 1, updatedAt: -1 });
invoiceSchema.index({ "gateway.transactionId": 1 });

module.exports = mongoose.model("Invoice", invoiceSchema);
