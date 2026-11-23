const mongoose = require("mongoose");
const Notification = require("../models/Notification");

const serverError = (res, where, error) => {
  console.error(where, error);
  return res.status(500).json({ message: "Impossible de charger les notifications. Réessayez." });
};

// ======================
// GET USER NOTIFICATIONS
// ======================
exports.getNotifications = async (req, res) => {
  try {
    const page = Math.max(1, parseInt(req.query.page, 10) || 1);
    const limit = Math.min(50, Math.max(1, parseInt(req.query.limit, 10) || 20));
    const skip = (page - 1) * limit;

    const notifications = await Notification.find({
      userId: req.user.id,
    })
      .sort({ createdAt: -1 })
      .skip(skip)
      .limit(limit)
      .lean();

    const total = await Notification.countDocuments({
      userId: req.user.id,
    });

    const unreadCount = await Notification.countDocuments({
      userId: req.user.id,
      isRead: false,
    });

    res.json({
      data: notifications,
      pagination: {
        total,
        page,
        pages: Math.ceil(total / limit),
      },
      unreadCount,
    });

  } catch (error) {
    return serverError(res, "notifications", error);
  }
};

// ======================
// MARK AS READ (ONE)
// ======================
exports.markAsRead = async (req, res) => {
  try {
    if (!mongoose.isValidObjectId(req.params.id)) {
      return res.status(400).json({ message: "Identifiant invalide" });
    }
    const notification = await Notification.findOne({
      _id: req.params.id,
      userId: req.user.id, // 🔐 SECURITY FIX
    });

    if (!notification) {
      return res.status(404).json({
        message: "Notification introuvable",
      });
    }

    notification.isRead = true;
    await notification.save();

    res.json({
      message: "Notification lue",
      notification,
    });

  } catch (error) {
    return serverError(res, "notifications", error);
  }
};

// ======================
// MARK ALL AS READ
// ======================
exports.markAllAsRead = async (req, res) => {
  try {
    await Notification.updateMany(
      {
        userId: req.user.id,
        isRead: false,
      },
      {
        $set: { isRead: true },
      }
    );

    res.json({
      message: "Toutes les notifications marquées comme lues",
    });

  } catch (error) {
    return serverError(res, "notifications", error);
  }
};

// ======================
// GET UNREAD COUNT ONLY
// ======================
exports.getUnreadCount = async (req, res) => {
  try {
    const count = await Notification.countDocuments({
      userId: req.user.id,
      isRead: false,
    });

    res.json({ unreadCount: count });

  } catch (error) {
    return serverError(res, "notifications", error);
  }
};
