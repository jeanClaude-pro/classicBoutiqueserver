/*
 * Seeds the Category collection with the boutique's real subcategories
 * (shoes and clothes). Safe to re-run: existing categories are matched by
 * name and left untouched, only missing ones are inserted.
 *
 * Usage:
 *   node scripts/seedCategories.js
 */
require("dotenv").config();
const mongoose = require("mongoose");
const Category = require("../models/Category");

const categories = [
  // Chaussures (SHOES)
  { name: "Baskets", description: "Sneakers et chaussures de sport" },
  { name: "Chaussures de ville", description: "Chaussures habillées / formelles" },
  { name: "Chaussures décontractées", description: "Chaussures casual du quotidien" },
  { name: "Mocassins", description: "Mocassins et loafers" },
  { name: "Sandales", description: "Sandales et tongs" },
  { name: "Talons", description: "Chaussures à talons" },
  { name: "Bottes", description: "Bottes et bottines" },
  { name: "Pantoufles", description: "Chaussons et pantoufles d'intérieur" },
  { name: "Chaussures de Sport", description: "Chaussures de sport et running" },

  // Vêtements (CLOTHES)
  { name: "T-Shirts", description: "T-shirts et hauts décontractés" },
  { name: "Chemises", description: "Chemises habillées et décontractées" },
  { name: "Polos", description: "Polos / polo shirts" },
  { name: "Pantalons", description: "Pantalons et chinos" },
  { name: "Jeans", description: "Jeans et denim" },
  { name: "Shorts", description: "Shorts et bermudas" },
  { name: "Vestes", description: "Vestes et manteaux" },
  { name: "Costumes", description: "Costumes et tenues formelles" },
  { name: "Sweats à Capuche", description: "Hoodies et sweats à capuche" },
  { name: "Pulls", description: "Pulls et sweats" },
  { name: "Robes", description: "Robes pour femmes" },
  { name: "Jupes", description: "Jupes" },
  { name: "Blouses", description: "Blouses et chemisiers" },
  { name: "Ensembles", description: "Ensembles / tenues assorties" },
  { name: "Sportswear", description: "Tenues et vêtements de sport" },
  { name: "Sous-vêtements", description: "Sous-vêtements" },

  // Autres
  { name: "Autres", description: "Autres articles non classés" },
];

async function seed() {
  const uri = process.env.MONGO_URI || "mongodb://127.0.0.1:27017/classic-boutique";
  await mongoose.connect(uri);
  console.log("Connected to MongoDB for seeding categories");

  let created = 0;
  let skipped = 0;
  for (const category of categories) {
    const result = await Category.updateOne(
      { name: category.name },
      { $setOnInsert: category },
      { upsert: true }
    );
    if (result.upsertedCount > 0) created++;
    else skipped++;
  }

  console.log(`Categories seeded: ${created} created, ${skipped} already existed`);
  await mongoose.connection.close();
}

seed().catch((error) => {
  console.error("Error seeding categories:", error?.message || error);
  process.exit(1);
});
