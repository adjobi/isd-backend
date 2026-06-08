const mongoose = require("mongoose");

const notificationSchema = new mongoose.Schema(
  {
    // ======================
    // TARGET USER
    // ======================
    userId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "User",
      required: true,
    },

    // ======================
    // CONTENT
    // ======================
    title: {
      type: String,
      required: true,
    },

    message: {
      type: String,
      required: true,
    },

    // ======================
    // TYPE SYSTEM
    // ======================
    type: {
      type: String,
      enum: [
        "booking_request",
        "booking_accepted",
        "booking_rejected",
        "booking_started",
        "booking_completed",
        "chat_message",
        "system_alert",
      ],
      required: true,
    },

    // ======================
    // STATUS
    // ======================
    isRead: {
      type: Boolean,
      default: false,
    },

    // ======================
    // RELATIONS
    // ======================
    relatedBookingId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Booking",
    },

    // ======================
    // REAL-TIME SYSTEM SUPPORT
    // ======================
    channel: {
      type: String,
      enum: ["socket", "push", "inapp"],
      default: "inapp",
    },

    priority: {
      type: String,
      enum: ["low", "normal", "high", "urgent"],
      default: "normal",
    },

    metadata: {
      type: Object,
      default: {},
    },
  },
  { timestamps: true }
);

module.exports = mongoose.model("Notification", notificationSchema);
