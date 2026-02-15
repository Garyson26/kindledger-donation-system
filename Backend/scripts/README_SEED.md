# Database Seeding Script

## Overview
This script generates **1000 dummy users** with authentic Indian names and creates **donation records with strictly controlled yearly amounts**, ensuring proper financial constraints and realistic data distribution.

## ⚠️ Yearly Amount Control
The script implements **strict yearly donation amount control**:

- **Minimum per year**: ₹2,50,000 (keeps generating until reached)
- **Target range**: ₹3,00,000 to ₹4,00,000 (stops when reached)
- **Absolute maximum**: ₹4,00,000 (never exceeds)
- **Years covered**: Last 3 years (2024, 2025, 2026)

### How It Works
1. For each year, donations are generated until yearly total reaches minimum ₹2,50,000
2. Continues generating until total is between ₹3,00,000 to ₹4,00,000
3. Stops immediately when reaching target range
4. Never exceeds ₹4,00,000 in any year
5. Only **paid donations** count towards yearly totals

## Features

### 👥 User Generation (1000 users)
- **Indian Names**: Realistic first and last names from various Indian regions
- **Mobile Numbers**: Valid Indian format (+91 XXXXXXXXXX)
- **Email Addresses**: Gmail, Yahoo, Outlook, Rediffmail, Hotmail
- **Cities**: 50+ major Indian cities
- **Addresses**: Realistic Indian street addresses
- **Registration Dates**: Random dates from the last 2 years
- **Default Password**: `Password@123` for all users

### 💰 Smart Donation Generation
- **Intelligent Amount Selection**: 
  - Favors larger donations (₹50,000) when far from target
  - Uses medium donations (₹2,000) in mid-range
  - Switches to small donations (₹300) when close to target
- **Payment Methods**: UPI, Card, NetBanking (randomly distributed)
- **Payment Status Distribution**:
  - 95% Paid (Successful)
  - 4% Pending
  - 1% Failed
- **Yearly Distribution**: Donations spread across 3 years with controlled totals

### 📊 Donation Categories & Amounts

1. **Education Support** - Base: ₹300
   - Books and stationery
   - School uniforms
   - Educational materials
   - Online learning resources

2. **Medical Aid** - Base: ₹2,000
   - Medical supplies
   - Hospital bills
   - Medicine
   - Health checkups

3. **Community Development** - Base: ₹50,000
   - Infrastructure development
   - Clean water projects
   - Sanitation facilities
   - Community centers

**Extra Amount**: Each donation includes an extra amount (0-30% of base amount) for realistic variance

## Usage

### Method 1: Using npm script (Recommended)
```bash
cd Backend
npm run seed
```

### Method 2: Direct execution
```bash
cd Backend
node scripts/seedDatabase.js
```

## Output Example

```
🔌 Connecting to MongoDB...
   Using database: ocean-foundation
✅ Connected to MongoDB

🗑️  Clearing existing data...
✅ Cleared existing data

📦 Checking categories...
✅ Found 3 existing categories

👥 Generating 1000 users with Indian names...
   Generated 100/1000 users...
   Generated 200/1000 users...
   ...
   Generated 1000/1000 users...
💾 Inserting users into database...
✅ Created 1000 users

💰 Generating donation records with yearly amount control...
   Rules:
   - Minimum ₹2,50,000 per year
   - Stop between ₹3,00,000 to ₹4,00,000
   - Maximum ₹4,00,000 per year

📅 Generating donations for year 2024...
   Generated 50 donations... Year 2024: ₹1,20,450
   Generated 100 donations... Year 2024: ₹2,45,300
   Generated 150 donations... Year 2024: ₹3,15,200
   ✅ Year 2024 complete: ₹3,15,200 (150 donations)

📅 Generating donations for year 2025...
   Generated 200 donations... Year 2025: ₹2,10,300
   Generated 250 donations... Year 2025: ₹3,50,100
   ✅ Year 2025 complete: ₹3,50,100 (145 donations)

📅 Generating donations for year 2026...
   Generated 300 donations... Year 2026: ₹1,85,000
   Generated 350 donations... Year 2026: ₹3,20,500
   ✅ Year 2026 complete: ₹3,20,500 (138 donations)

💾 Inserting donation records into database...
   Inserted 433/433 donations...
✅ Created 433 donation records

📊 Database Statistics:
   👥 Total Users: 1000
   💰 Total Donations: 433
   ✅ Paid Donations: 411 (95.0%)
   ⏳ Pending Donations: 17 (4.0%)
   ❌ Failed Donations: 5 (1.0%)
   💵 Total Amount Collected: ₹9,85,800

📅 Yearly Breakdown (Paid Donations Only):
   2024: ₹3,15,200 (150 donations)
   2025: ₹3,50,100 (145 donations)
   2026: ₹3,20,500 (116 donations)

🎉 Database seeding completed successfully!

📝 Sample User Credentials:
   Email: (any generated email)
   Password: Password@123

🔌 Database connection closed
```

## Sample Generated Data

### Sample User
```json
{
  "name": "Aarav Sharma",
  "email": "aarav.sharma@gmail.com",
  "phone": "+91 9876543210",
  "address": "123, MG Road, Mumbai",
  "role": "user",
  "isActive": true,
  "createdAt": "2024-06-15T10:30:45.000Z"
}
```

### Sample Donation
```json
{
  "userId": "ObjectId('...')",
  "donorName": "Aarav Sharma",
  "donorEmail": "aarav.sharma@gmail.com",
  "donorPhone": "+91 9876543210",
  "category": "ObjectId('...')",
  "item": "Education Support",
  "quantity": 1,
  "baseAmount": 300,
  "extraAmount": 150,
  "amount": 450,
  "paymentStatus": "Paid",
  "paymentMethod": "UPI",
  "transactionId": "TXN1705401234567",
  "date": "2024-08-20T14:22:10.000Z",
  "createdAt": "2024-08-20T14:22:10.000Z"
}
```

## Data Characteristics

### Indian Names Distribution
- **100 First Names**: Mix of traditional and modern Indian names
- **100 Last Names**: From various Indian states and communities
- **Realistic Combinations**: Authentic Indian naming patterns

### Cities Covered (50+)
Mumbai, Delhi, Bangalore, Hyderabad, Chennai, Kolkata, Pune, Ahmedabad, Jaipur, Lucknow, and 40+ more major Indian cities

### Mobile Numbers
- Format: +91 XXXXXXXXXX
- Valid Indian prefixes: 98, 99, 97, 96, 95, 94, 93, 92, 91, 90, 89, 88, 87, 86, 85, 84, 83, 82, 81, 80

### Email Domains
- gmail.com
- yahoo.com
- outlook.com
- rediffmail.com
- hotmail.com

## Database Impact

**Before Running:**
- Clears ALL existing users with email domains matching the generated ones
- Clears ALL existing donations
- Creates default categories if they don't exist

**After Running:**
- 1000 new users
- 4000-8000 donation records (average: 5000)
- Proper user-donation relationships maintained
- Transaction IDs for successful payments

## Testing & Verification

### Login as Generated User
```bash
Email: (any generated email from database)
Password: Password@123
```

### Verify Data in MongoDB
```bash
# Connect to MongoDB
mongosh

# Switch to database
use ocean-foundation

# Count users
db.users.countDocuments()

# Count donations
db.donations.countDocuments()

# Check payment status distribution
db.donations.aggregate([
  { $group: { _id: "$paymentStatus", count: { $sum: 1 } } }
])

# Check total amount by category
db.donations.aggregate([
  { $match: { paymentStatus: "Paid" } },
  { $lookup: { from: "categories", localField: "category", foreignField: "_id", as: "cat" } },
  { $unwind: "$cat" },
  { $group: { _id: "$cat.name", total: { $sum: "$amount" }, count: { $sum: 1 } } }
])
```

## Performance

- **Execution Time**: ~30-60 seconds (depending on system)
- **Memory Usage**: ~200-300 MB
- **Database Size**: ~50-100 MB additional storage

## Notes

⚠️ **Warning**: This script will DELETE existing users and donations before seeding!

✅ **Safe to run multiple times**: Script clears data before inserting new records

🔒 **All users have same password**: `Password@123` (hash: bcrypt with 10 rounds)

📅 **Date Range**: Last 2 years from current date

💳 **Transaction IDs**: Only generated for "Paid" donations

## Troubleshooting

### Error: Cannot connect to MongoDB
**Solution**: Check your `.env` file and ensure MongoDB is running
```bash
# Check MongoDB connection string in .env
MONGO_URI=mongodb://localhost:27017/ocean-foundation
```

### Error: Categories not found
**Solution**: Script will automatically create default categories

### Script hangs
**Solution**: 
1. Check MongoDB connection
2. Ensure sufficient memory (at least 1GB available)
3. Check for database locks

### Duplicate key error
**Solution**: Script clears data first, but if error persists:
```bash
# Manually clear collections
mongosh
use donation-system
db.users.deleteMany({})
db.donations.deleteMany({})
```

## Customization

To modify the seed data, edit `scripts/seedDatabase.js`:

```javascript
// Change number of users
const NUM_USERS = 1000; // Change this

// Change donations per user
const numDonations = randomInt(2, 8); // Modify range

// Change payment success rate
if (rand < 0.90) paymentStatus = 'Paid'; // Modify percentage

// Add more cities
const indianCities = [...]; // Add cities

// Add more names
const indianFirstNames = [...]; // Add names
```

## Statistics Expected

With yearly amount control (3 years of data):

- **Total Donations**: ~400-500 donations
- **Yearly Amount Range**: ₹3,00,000 - ₹4,00,000 per year
- **Total 3-Year Amount**: ₹9,00,000 - ₹12,00,000
- **Paid Donations**: ~95%
- **Average Donation Size**: Varies based on yearly target proximity

### Yearly Control Logic
- **Far from target** (< ₹1,00,000): 60% large (₹50,000), 30% medium (₹2,000), 10% small (₹300)
- **Mid-range** (₹1,00,000 - ₹2,90,000): 30% large, 50% medium, 20% small
- **Near target** (₹2,90,000 - ₹4,00,000): Mostly small/medium to avoid exceeding limit

## Related Files

- **Seed Script**: `Backend/scripts/seedDatabase.js`
- **User Model**: `Backend/models/User.js`
- **Donation Model**: `Backend/models/Donation.js`
- **Category Model**: `Backend/models/Category.js`

---

**Created**: January 11, 2026  
**Version**: 1.0  
**Author**: Smart Donation System

