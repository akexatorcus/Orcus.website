// server.js - Main server file
const express = require('express');
const cors = require('cors');
const cron = require('node-cron');
const { scrapeAllSources } = require('./scrapers/newsScrapers');
const { categorizeNews } = require('./utils/categorizer');
const { removeDuplicates } = require('./utils/deduplicator');

const app = express();
const PORT = process.env.PORT || 3001;

// Middleware
app.use(cors());
app.use(express.json());
app.use(express.static('public'));

// In-memory storage (use a database in production)
let newsDatabase = [];
let lastUpdated = null;

// API Routes
app.get('/api/news', (req, res) => {
    const { category, limit = 20 } = req.query;
    
    let filteredNews = newsDatabase;
    
    if (category && category !== 'all') {
        filteredNews = newsDatabase.filter(item => item.category === category);
    }
    
    const limitedNews = filteredNews.slice(0, parseInt(limit));
    
    res.json({
        news: limitedNews,
        lastUpdated,
        total: filteredNews.length
    });
});

app.post('/api/refresh', async (req, res) => {
    try {
        console.log('Manual refresh triggered...');
        await updateNewsDatabase();
        res.json({ 
            success: true, 
            message: 'News updated successfully',
            count: newsDatabase.length 
        });
    } catch (error) {
        console.error('Manual refresh failed:', error);
        res.status(500).json({ 
            success: false, 
            message: 'Failed to update news' 
        });
    }
});

// Update news database function
async function updateNewsDatabase() {
    try {
        console.log('Starting news scraping...');
        
        // Scrape from all sources
        const scrapedNews = await scrapeAllSources();
        console.log(`Scraped ${scrapedNews.length} articles`);
        
        // Remove duplicates
        const uniqueNews = removeDuplicates(scrapedNews);
        console.log(`${uniqueNews.length} unique articles after deduplication`);
        
        // Categorize news
        const categorizedNews = uniqueNews.map(article => ({
            ...article,
            category: categorizeNews(article.title, article.content),
            id: Date.now() + Math.random(),
            timestamp: new Date().toISOString()
        }));
        
        // Update database
        newsDatabase = categorizedNews.sort((a, b) => 
            new Date(b.publishedAt || b.timestamp) - new Date(a.publishedAt || a.timestamp)
        );
        
        lastUpdated = new Date().toISOString();
        console.log('News database updated successfully');
        
    } catch (error) {
        console.error('Error updating news database:', error);
    }
}

// Schedule automatic updates every 30 minutes
cron.schedule('*/30 * * * *', () => {
    console.log('Scheduled news update starting...');
    updateNewsDatabase();
});

// Initial data load
updateNewsDatabase();

app.listen(PORT, () => {
    console.log(`Server running on http://localhost:${PORT}`);
    console.log('News scraping service started');
});

// scrapers/newsScrapers.js - Web scraping logic
const puppeteer = require('puppeteer');
const cheerio = require('cheerio');
const axios = require('axios');

// Scraper configurations
const scraperConfigs = [
    {
        name: 'TechCrunch',
        url: 'https://techcrunch.com/category/startups/',
        scraper: scrapeTechCrunch
    },
    {
        name: 'VentureBeat',
        url: 'https://venturebeat.com/category/startups/',
        scraper: scrapeVentureBeat
    },
    {
        name: 'The Information',
        url: 'https://www.theinformation.com/briefings',
        scraper: scrapeTheInformation
    },
    {
        name: 'Crunchbase News',
        url: 'https://news.crunchbase.com/',
        scraper: scrapeCrunchbaseNews
    }
];

async function scrapeAllSources() {
    const allNews = [];
    
    for (const config of scraperConfigs) {
        try {
            console.log(`Scraping ${config.name}...`);
            const news = await config.scraper(config.url);
            const newsWithSource = news.map(article => ({
                ...article,
                source: config.name,
                sourceUrl: config.url
            }));
            allNews.push(...newsWithSource);
            console.log(`Found ${news.length} articles from ${config.name}`);
            
            // Add delay between requests to be respectful
            await new Promise(resolve => setTimeout(resolve, 2000));
        } catch (error) {
            console.error(`Error scraping ${config.name}:`, error.message);
        }
    }
    
    return allNews;
}

async function scrapeTechCrunch(url) {
    try {
        const browser = await puppeteer.launch({ headless: true });
        const page = await browser.newPage();
        
        await page.setUserAgent('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36');
        await page.goto(url, { waitUntil: 'networkidle2', timeout: 30000 });
        
        const articles = await page.evaluate(() => {
            const items = [];
            const articleElements = document.querySelectorAll('.post-block');
            
            articleElements.forEach((element, index) => {
                if (index >= 10) return; // Limit to 10 articles
                
                const titleElement = element.querySelector('.post-block__title__link');
                const excerptElement = element.querySelector('.post-block__content');
                const timeElement = element.querySelector('time');
                
                if (titleElement) {
                    items.push({
                        title: titleElement.textContent.trim(),
                        content: excerptElement ? excerptElement.textContent.trim() : '',
                        url: titleElement.href,
                        publishedAt: timeElement ? timeElement.getAttribute('datetime') : null,
                        tags: ['Startup', 'Technology']
                    });
                }
            });
            
            return items;
        });
        
        await browser.close();
        return articles;
    } catch (error) {
        console.error('TechCrunch scraping error:', error);
        return [];
    }
}

async function scrapeVentureBeat(url) {
    try {
        const response = await axios.get(url, {
            headers: {
                'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36'
            },
            timeout: 15000
        });
        
        const $ = cheerio.load(response.data);
        const articles = [];
        
        $('.ArticleListing').each((index, element) => {
            if (index >= 10) return;
            
            const title = $(element).find('.ArticleListing__title a').text().trim();
            const content = $(element).find('.ArticleListing__excerpt').text().trim();
            const url = $(element).find('.ArticleListing__title a').attr('href');
            const publishedAt = $(element).find('time').attr('datetime');
            
            if (title) {
                articles.push({
                    title,
                    content,
                    url: url ? (url.startsWith('http') ? url : `https://venturebeat.com${url}`) : '',
                    publishedAt,
                    tags: ['Startup', 'Venture Capital']
                });
            }
        });
        
        return articles;
    } catch (error) {
        console.error('VentureBeat scraping error:', error);
        return [];
    }
}

async function scrapeTheInformation(url) {
    // Note: The Information requires subscription, so this is a placeholder
    // You would need to implement authentication or use their API if available
    try {
        // Placeholder implementation
        return [
            {
                title: "Sample News from The Information",
                content: "This would contain actual scraped content from The Information with proper authentication.",
                url: "https://www.theinformation.com/sample",
                publishedAt: new Date().toISOString(),
                tags: ['Startup', 'Premium']
            }
        ];
    } catch (error) {
        console.error('The Information scraping error:', error);
        return [];
    }
}

async function scrapeCrunchbaseNews(url) {
    try {
        const browser = await puppeteer.launch({ headless: true });
        const page = await browser.newPage();
        
        await page.setUserAgent('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36');
        await page.goto(url, { waitUntil: 'networkidle2', timeout: 30000 });
        
        const articles = await page.evaluate(() => {
            const items = [];
            const articleElements = document.querySelectorAll('[data-testid="news-card"]');
            
            articleElements.forEach((element, index) => {
                if (index >= 10) return;
                
                const titleElement = element.querySelector('h3 a');
                const contentElement = element.querySelector('.description');
                const timeElement = element.querySelector('time');
                
                if (titleElement) {
                    items.push({
                        title: titleElement.textContent.trim(),
                        content: contentElement ? contentElement.textContent.trim() : '',
                        url: titleElement.href,
                        publishedAt: timeElement ? timeElement.getAttribute('datetime') : null,
                        tags: ['Startup', 'Funding', 'Crunchbase']
                    });
                }
            });
            
            return items;
        });
        
        await browser.close();
        return articles;
    } catch (error) {
        console.error('Crunchbase News scraping error:', error);
        return [];
    }
}

module.exports = { scrapeAllSources };

// utils/categorizer.js - News categorization logic
function categorizeNews(title, content) {
    const text = (title + ' ' + content).toLowerCase();
    
    // Funding keywords
    if (text.match(/\b(raise[sd]?|funding|investment|series [abcdef]|seed|round|million|billion|venture capital|vc)\b/)) {
        return 'funding';
    }
    
    // Acquisition keywords
    if (text.match(/\b(acquire[sd]?|acquisition|merger|bought|purchase[sd]?|deal|m&a)\b/)) {
        return 'acquisition';
    }
    
    // IPO keywords
    if (text.match(/\b(ipo|initial public offering|public|nasdaq|nyse|stock market|listing)\b/)) {
        return 'ipo';
    }
    
    // Product launch keywords
    if (text.match(/\b(launch[es]?|release[sd]?|unveil[s]?|debut|introduce[sd]?|new product|beta)\b/)) {
        return 'product';
    }
    
    // Leadership keywords
    if (text.match(/\b(ceo|cto|cfo|founder|appoint[s]?|hire[sd]?|join[s]?|executive|leadership)\b/)) {
        return 'leadership';
    }
    
    // Default category
    return 'general';
}

module.exports = { categorizeNews };

// utils/deduplicator.js - Remove duplicate articles
function removeDuplicates(articles) {
    const seen = new Set();
    const unique = [];
    
    for (const article of articles) {
        // Create a simple hash of title and content
        const hash = article.title.toLowerCase().replace(/\s+/g, ' ').trim();
        
        if (!seen.has(hash)) {
            seen.add(hash);
            unique.push(article);
        }
    }
    
    return unique;
}

function similarity(str1, str2) {
    const words1 = new Set(str1.toLowerCase().split(/\s+/));
    const words2 = new Set(str2.toLowerCase().split(/\s+/));
    
    const intersection = new Set([...words1].filter(x => words2.has(x)));
    const union = new Set([...words1, ...words2]);
    
    return intersection.size / union.size;
}

module.exports = { removeDuplicates };

// package.json - Dependencies
{
  "name": "startup-news-scraper",
  "version": "1.0.0",
  "description": "Web scraper for startup news",
  "main": "server.js",
  "scripts": {
    "start": "node server.js",
    "dev": "nodemon server.js",
    "install-deps": "npm install express cors puppeteer cheerio axios node-cron"
  },
  "dependencies": {
    "express": "^4.18.2",
    "cors": "^2.8.5",
    "puppeteer": "^21.5.0",
    "cheerio": "^1.0.0-rc.12",
    "axios": "^1.6.0",
    "node-cron": "^3.0.3"
  },
  "devDependencies": {
    "nodemon": "^3.0.1"
  }
}
