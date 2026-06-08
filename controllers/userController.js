const User = require("../models/User");

exports.completeProfile = async (req, res) => {
  try {
    const { firstName, lastName, phone, city, subjects } = req.body;

    const user = await User.findById(req.user.id);

    if (!user) {
      return res.status(404).json({ message: "User not found" });
    }

    user.firstName = firstName;
    user.lastName = lastName;
    user.phone = phone;
    user.city = city;

    if (user.role === "tutor") {
      user.subjects = subjects;
    }

    user.isProfileCompleted = true;

    await user.save();

    res.json({ message: "Profile completed", user });
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
};
