require('dotenv').config();
const mongoose = require('mongoose');
const bcrypt = require('bcryptjs');
const User = require('../models/User');
const Donation = require('../models/Donation');
const Category = require('../models/Category');

// Indian names data
const indianFirstNames = [
  'Aarav', 'Vivaan', 'Aditya', 'Vihaan', 'Arjun', 'Sai', 'Arnav', 'Ayaan', 'Krishna', 'Ishaan',
  'Shaurya', 'Atharv', 'Advaith', 'Pranav', 'Dhruv', 'Aryan', 'Kabir', 'Shivansh', 'Ritvik', 'Ojas',
  'Aarohi', 'Saanvi', 'Pari', 'Ananya', 'Diya', 'Aadhya', 'Pihu', 'Myra', 'Anika', 'Navya',
  'Angel', 'Ira', 'Riya', 'Anvi', 'Prisha', 'Kiara', 'Ishita', 'Shanaya', 'Tanvi', 'Khushi',
  'Rajesh', 'Amit', 'Suresh', 'Ramesh', 'Mahesh', 'Dinesh', 'Prakash', 'Vijay', 'Ajay', 'Sanjay',
  'Priya', 'Pooja', 'Neha', 'Sneha', 'Kavita', 'Anjali', 'Deepika', 'Swati', 'Shweta', 'Nikita',
  'Rohan', 'Rahul', 'Varun', 'Karan', 'Nikhil', 'Vishal', 'Akash', 'Ankit', 'Ashish', 'Gaurav',
  'Simran', 'Preeti', 'Divya', 'Pallavi', 'Megha', 'Richa', 'Shreya', 'Kritika', 'Jyoti', 'Sakshi',
  'Manish', 'Pankaj', 'Sachin', 'Ravi', 'Naveen', 'Arun', 'Ashok', 'Mohan', 'Gopal', 'Harish',
  'Sunita', 'Rekha', 'Geeta', 'Meena', 'Ritu', 'Seema', 'Usha', 'Vandana', 'Madhuri', 'Savita'
];

const indianLastNames = [
  'Sharma', 'Verma', 'Patel', 'Kumar', 'Singh', 'Gupta', 'Agarwal', 'Jain', 'Reddy', 'Rao',
  'Iyer', 'Nair', 'Menon', 'Pillai', 'Das', 'Dutta', 'Chatterjee', 'Mukherjee', 'Banerjee', 'Sen',
  'Desai', 'Mehta', 'Shah', 'Thakur', 'Kulkarni', 'Joshi', 'Deshpande', 'Patil', 'Naik', 'More',
  'Khan', 'Ahmed', 'Ali', 'Hussain', 'Ansari', 'Siddiqui', 'Malik', 'Shaikh', 'Qureshi', 'Mirza',
  'Bhat', 'Kaul', 'Wani', 'Lone', 'Dar', 'Rather', 'Ganaie', 'Mir', 'Baba', 'Kak',
  'Choudhury', 'Roy', 'Ghosh', 'Bose', 'Saha', 'Paul', 'Biswas', 'Sarkar', 'Chakraborty', 'Mazumdar',
  'Nambiar', 'Varma', 'Krishnan', 'Raman', 'Subramaniam', 'Venkatesh', 'Natarajan', 'Sundaram', 'Balan', 'Menon',
  'Chand', 'Goel', 'Kapoor', 'Malhotra', 'Khanna', 'Chopra', 'Sethi', 'Anand', 'Bhatia', 'Arora',
  'Naidu', 'Raju', 'Varma', 'Prasad', 'Murthy', 'Yadav', 'Reddy', 'Goud', 'Naik', 'Shetty',
  'Pandey', 'Mishra', 'Tiwari', 'Dubey', 'Shukla', 'Dixit', 'Tripathi', 'Dwivedi', 'Jha', 'Ojha'
];

const indianCities = [
  'Mumbai', 'Delhi', 'Bangalore', 'Hyderabad', 'Chennai', 'Kolkata', 'Pune', 'Ahmedabad',
  'Surat', 'Jaipur', 'Lucknow', 'Kanpur', 'Nagpur', 'Indore', 'Thane', 'Bhopal',
  'Visakhapatnam', 'Pimpri-Chinchwad', 'Patna', 'Vadodara', 'Ghaziabad', 'Ludhiana',
  'Agra', 'Nashik', 'Faridabad', 'Meerut', 'Rajkot', 'Kalyan-Dombivali', 'Vasai-Virar',
  'Varanasi', 'Srinagar', 'Aurangabad', 'Dhanbad', 'Amritsar', 'Navi Mumbai', 'Allahabad',
  'Ranchi', 'Howrah', 'Coimbatore', 'Jabalpur', 'Gwalior', 'Vijayawada', 'Jodhpur',
  'Madurai', 'Raipur', 'Kota', 'Chandigarh', 'Guwahati', 'Solapur', 'Hubli-Dharwad'
];

const paymentMethods = ['UPI', 'Card', 'NetBanking'];

// Helper functions
function randomElement(array) {
  return array[Math.floor(Math.random() * array.length)];
}

function randomInt(min, max) {
  return Math.floor(Math.random() * (max - min + 1)) + min;
}

function generateIndianMobile() {
  const prefixes = ['98', '99', '97', '96', '95', '94', '93', '92', '91', '90', '89', '88', '87', '86', '85', '84', '83', '82', '81', '80'];
  return `+91 ${randomElement(prefixes)}${randomInt(10000000, 99999999)}`;
}

function generateEmail(firstName, lastName, index) {
  const domains = ['gmail.com', 'yahoo.com', 'outlook.com', 'rediffmail.com', 'hotmail.com'];
  const randomSuffix = randomInt(100, 9999);
  const timestamp = Date.now().toString().slice(-4);

  const formats = [
    `${firstName.toLowerCase()}.${lastName.toLowerCase()}${randomSuffix}@${randomElement(domains)}`,
    `${firstName.toLowerCase()}${lastName.toLowerCase()}${index}@${randomElement(domains)}`,
    `${firstName.toLowerCase()}${randomInt(1, 999)}${timestamp}@${randomElement(domains)}`,
    `${firstName.toLowerCase()}.${lastName.toLowerCase()}${index}${randomSuffix}@${randomElement(domains)}`
  ];
  return randomElement(formats);
}

function generateRandomDate(startDate, endDate) {
  const start = startDate.getTime();
  const end = endDate.getTime();
  const randomTime = start + Math.random() * (end - start);
  return new Date(randomTime);
}

function generateAddress(city) {
  const houseNo = randomInt(1, 500);
  const streets = ['MG Road', 'Gandhi Street', 'Park Avenue', 'Station Road', 'Main Street', 'Market Road', 'Temple Street', 'Church Road'];
  return `${houseNo}, ${randomElement(streets)}, ${city}`;
}

// Main seed function
async function seedDatabase() {
  try {
    console.log('🔌 Connecting to MongoDB...');
    const mongoUri = process.env.MONGODB_URI || process.env.MONGO_URI || 'mongodb://localhost:27017/ocean-foundation';
    console.log(`   Using database: ${mongoUri.split('/').pop()}`);

    await mongoose.connect(mongoUri);
    console.log('✅ Connected to MongoDB');

    // Clear existing data
    console.log('\n🗑️  Clearing existing data...');
    await User.deleteMany({ email: { $regex: '@(gmail|yahoo|outlook|rediffmail|hotmail)' } });
    await Donation.deleteMany({});
    console.log('✅ Cleared existing data');

    // Get or create categories
    console.log('\n📦 Checking categories...');
    let categories = await Category.find();

    if (categories.length === 0) {
      console.log('Creating default categories...');
      categories = await Category.create([
        {
          name: 'Education Support',
          sortDescription: 'Support education for underprivileged children',
          donationAmount: 300,
          descriptions: ['Books and stationery', 'School uniforms', 'Educational materials', 'Online learning resources']
        },
        {
          name: 'Medical Aid',
          sortDescription: 'Help provide medical care to those in need',
          donationAmount: 2000,
          descriptions: ['Medical supplies', 'Hospital bills', 'Medicine', 'Health checkups']
        },
        {
          name: 'Community Development',
          sortDescription: 'Build better communities together',
          donationAmount: 50000,
          descriptions: ['Infrastructure development', 'Clean water projects', 'Sanitation facilities', 'Community centers']
        }
      ]);
      console.log('✅ Created default categories');
    } else {
      console.log(`✅ Found ${categories.length} existing categories`);
    }

    // Create category mapping
    const categoryMap = {
      300: categories.find(c => c.donationAmount === 300) || categories[0],
      2000: categories.find(c => c.donationAmount === 2000) || categories[1],
      50000: categories.find(c => c.donationAmount === 50000) || categories[2]
    };

    // Generate 1000 users
    console.log('\n👥 Generating 1000 users with Indian names...');
    const users = [];
    const hashedPassword = await bcrypt.hash('Password@123', 10);

    for (let i = 0; i < 1000; i++) {
      const firstName = randomElement(indianFirstNames);
      const lastName = randomElement(indianLastNames);
      const city = randomElement(indianCities);

      const user = {
        name: `${firstName} ${lastName}`,
        email: generateEmail(firstName, lastName, i),
        password: hashedPassword,
        phone: generateIndianMobile(),
        address: generateAddress(city),
        role: 'user',
        isActive: true,
        createdAt: generateRandomDate(new Date(2024, 0, 1), new Date())
      };

      users.push(user);

      if ((i + 1) % 100 === 0) {
        console.log(`   Generated ${i + 1}/1000 users...`);
      }
    }

    console.log('💾 Inserting users into database...');
    const insertedUsers = await User.insertMany(users);
    console.log(`✅ Created ${insertedUsers.length} users`);

    // Generate donations with yearly amount control
    console.log('\n💰 Generating donation records with yearly amount control...');
    console.log('   Rules:');
    console.log('   - Minimum ₹2,50,000 per year');
    console.log('   - Stop between ₹3,00,000 to ₹4,00,000');
    console.log('   - Maximum ₹4,00,000 per year\n');

    const donations = [];
    const MIN_YEARLY_AMOUNT = 250000;
    const TARGET_MIN = 300000;
    const TARGET_MAX = 400000;
    const ABSOLUTE_MAX = 400000;

    // Define years to generate data for (last 3 years)
    const currentYear = new Date().getFullYear();
    const years = [currentYear - 2, currentYear - 1, currentYear];

    // Track yearly totals
    const yearlyTotals = {};
    years.forEach(year => yearlyTotals[year] = 0);

    let totalDonations = 0;
    let userIndex = 0;

    // Generate donations for each year
    for (const year of years) {
      console.log(`\n📅 Generating donations for year ${year}...`);
      const yearStart = new Date(year, 0, 1);
      const yearEnd = new Date(year, 11, 31, 23, 59, 59);
      
      userIndex = 0; // Reset user index for each year

      // Keep generating until we reach the target range
      while (yearlyTotals[year] < TARGET_MIN || 
             (yearlyTotals[year] < TARGET_MAX && yearlyTotals[year] < MIN_YEARLY_AMOUNT)) {
        
        // Select a random user
        const user = insertedUsers[userIndex % insertedUsers.length];
        userIndex++;

        // Select donation amount based on how much we need
        const remaining = TARGET_MAX - yearlyTotals[year];
        let baseAmount;
        
        if (remaining > 150000) {
          // If we need a lot more, balanced distribution favoring smaller amounts for more transactions
          const rand = Math.random();
          if (rand < 0.4) baseAmount = 300;
          else if (rand < 0.7) baseAmount = 2000;
          else baseAmount = 50000;
        } else if (remaining > 50000) {
          // Mid-range, prefer small and medium donations
          const rand = Math.random();
          if (rand < 0.5) baseAmount = 300;
          else if (rand < 0.85) baseAmount = 2000;
          else baseAmount = 50000;
        } else if (remaining > 10000) {
          // Getting close, avoid large donations
          const rand = Math.random();
          if (rand < 0.6) baseAmount = 300;
          else baseAmount = 2000;
        } else if (remaining > 2000) {
          // Very close, mostly small
          const rand = Math.random();
          if (rand < 0.7) baseAmount = 300;
          else baseAmount = 2000;
        } else {
          // Very close, use smallest
          baseAmount = 300;
        }

        const category = categoryMap[baseAmount];

        // Extra amount (0 to 30% of base amount to have better control)
        const extraAmount = randomInt(0, Math.floor(baseAmount * 0.3));
        const totalAmount = baseAmount + extraAmount;

        // Check if adding this donation would exceed ABSOLUTE_MAX
        if (yearlyTotals[year] + totalAmount > ABSOLUTE_MAX) {
          // Try with a smaller amount
          if (baseAmount > 300) {
            continue; // Skip and try with potentially smaller amount in next iteration
          } else {
            // Even smallest amount exceeds, stop for this year
            break;
          }
        }

        // Payment status (95% successful, 4% pending, 1% failed)
        const rand = Math.random();
        let paymentStatus;
        if (rand < 0.95) paymentStatus = 'Paid';
        else if (rand < 0.99) paymentStatus = 'Pending';
        else paymentStatus = 'Failed';

        const donationDate = generateRandomDate(yearStart, yearEnd);

        const donation = {
          userId: user._id,
          donorName: user.name,
          donorEmail: user.email,
          donorPhone: user.phone,
          category: category._id,
          item: category.name,
          quantity: 1,
          baseAmount: baseAmount,
          extraAmount: extraAmount,
          amount: totalAmount,
          paymentStatus: paymentStatus,
          paymentMethod: randomElement(paymentMethods),
          transactionId: paymentStatus === 'Paid' ? `TXN${year}${Date.now()}${randomInt(1000, 9999)}` : null,
          date: donationDate,
          createdAt: donationDate
        };

        donations.push(donation);
        totalDonations++;
        
        // Only count paid donations towards yearly total
        if (paymentStatus === 'Paid') {
          yearlyTotals[year] += totalAmount;
        }

        // Log progress
        if (totalDonations % 50 === 0) {
          console.log(`   Generated ${totalDonations} donations... Year ${year}: ₹${yearlyTotals[year].toLocaleString('en-IN')}`);
        }

        // Stop if we've reached the target range
        if (yearlyTotals[year] >= TARGET_MIN && yearlyTotals[year] <= TARGET_MAX) {
          console.log(`   ✅ Year ${year} complete: ₹${yearlyTotals[year].toLocaleString('en-IN')} (${donations.filter(d => new Date(d.date).getFullYear() === year && d.paymentStatus === 'Paid').length} paid donations)`);
          break;
        }
      }

      // Ensure minimum is met
      if (yearlyTotals[year] < MIN_YEARLY_AMOUNT) {
        console.log(`   ⚠️  Year ${year} below minimum: ₹${yearlyTotals[year].toLocaleString('en-IN')}`);
      }
    }

    console.log(`💾 Inserting ${donations.length} donation records into database...`);

    // Insert in batches of 1000 to avoid memory issues
    const batchSize = 1000;
    for (let i = 0; i < donations.length; i += batchSize) {
      const batch = donations.slice(i, i + batchSize);
      await Donation.insertMany(batch);
      console.log(`   Inserted ${Math.min(i + batchSize, donations.length)}/${donations.length} donations...`);
    }

    console.log(`✅ Created ${donations.length} donation records`);

    // Generate statistics
    console.log('\n📊 Database Statistics:');
    const totalUsers = await User.countDocuments();
    const totalDonationsCount = await Donation.countDocuments();
    const paidDonations = await Donation.countDocuments({ paymentStatus: 'Paid' });
    const pendingDonations = await Donation.countDocuments({ paymentStatus: 'Pending' });
    const failedDonations = await Donation.countDocuments({ paymentStatus: 'Failed' });

    const totalAmount = await Donation.aggregate([
      { $match: { paymentStatus: 'Paid' } },
      { $group: { _id: null, total: { $sum: '$amount' } } }
    ]);

    console.log(`   👥 Total Users: ${totalUsers}`);
    console.log(`   💰 Total Donations: ${totalDonationsCount}`);
    console.log(`   ✅ Paid Donations: ${paidDonations} (${((paidDonations/totalDonationsCount)*100).toFixed(1)}%)`);
    console.log(`   ⏳ Pending Donations: ${pendingDonations} (${((pendingDonations/totalDonationsCount)*100).toFixed(1)}%)`);
    console.log(`   ❌ Failed Donations: ${failedDonations} (${((failedDonations/totalDonationsCount)*100).toFixed(1)}%)`);
    console.log(`   💵 Total Amount Collected: ₹${(totalAmount[0]?.total || 0).toLocaleString('en-IN')}`);

    // Yearly breakdown
    console.log('\n📅 Yearly Breakdown (Paid Donations Only):');
    for (const year of years) {
      const yearDonations = await Donation.countDocuments({ 
        paymentStatus: 'Paid',
        date: { 
          $gte: new Date(year, 0, 1), 
          $lte: new Date(year, 11, 31, 23, 59, 59) 
        }
      });
      console.log(`   ${year}: ₹${yearlyTotals[year].toLocaleString('en-IN')} (${yearDonations} donations)`);
    }
    console.log('\n🎉 Database seeding completed successfully!');
    console.log('\n📝 Sample User Credentials:');
    console.log('   Email: (any generated email)');
    console.log('   Password: Password@123');

  } catch (error) {
    console.error('❌ Error seeding database:', error);
  } finally {
    await mongoose.connection.close();
    console.log('\n🔌 Database connection closed');
    process.exit(0);
  }
}

// Run the seed function
seedDatabase();

