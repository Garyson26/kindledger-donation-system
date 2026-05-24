const mongoose = require('mongoose');
require('dotenv').config();
const Category = require('./models/Category');

mongoose.connect(process.env.MONGODB_URI)
  .then(async () => {
    console.log('\n📋 Categories in database (sorted by displayOrder):\n');
    
    const categories = await Category.find().sort({ displayOrder: 1 });
    
    categories.forEach((cat, index) => {
      console.log(`${index + 1}. displayOrder: ${cat.displayOrder} - ${cat.name}`);
    });
    
    console.log('\n✅ Total categories:', categories.length);
    await mongoose.connection.close();
    process.exit(0);
  })
  .catch(err => {
    console.error('Error:', err);
    process.exit(1);
  });
