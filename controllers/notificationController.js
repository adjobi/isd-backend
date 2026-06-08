const Notification = require("../models/Notification");

// ======================
// GET USER NOTIFICATIONS
// ======================
exports.getNotifications = async (req, res) => {
  try {
    const { page = 1, limit = 20 } = req.query;

    const skip = (page - 1) * limit;

    const notifications = await Notification.find({
      userId: req.user.id,
    })
      .sort({ createdAt: -1 })
      .skip(skip)
      .limit(Number(limit));

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
        page: Number(page),
        pages: Math.ceil(total / limit),
      },
      unreadCount,
    });

  } catch (error) {
    res.status(500).json({ message: error.message });
  }
};

// ======================
// MARK AS READ (ONE)
// ======================
exports.markAsRead = async (req, res) => {
  try {
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
    res.status(500).json({ message: error.message });
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
    res.status(500).json({ message: error.message });
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
    res.status(500).json({ message: error.message });
  }
};
