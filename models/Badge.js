import mongoose from 'mongoose';

// User-created site categories ("E Commerce", "Chair", "Home & Lifestyle",
// ...) — managed in Settings, assigned to a site via its Edit modal (see
// routes/sites.js's PUT /:id, which writes the chosen badge name into
// Site.tags). A small fixed color palette is auto-assigned by creation
// order so badges look visually distinct without asking the user to pick a
// color for every one.
const BadgeSchema = new mongoose.Schema(
  {
    name:  { type: String, required: true, unique: true, trim: true },
    color: { type: String, required: true },
  },
  { timestamps: true }
);

export default mongoose.model('Badge', BadgeSchema);
