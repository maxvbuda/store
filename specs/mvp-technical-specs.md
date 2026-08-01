# AutoStore AI - MVP Technical Specifications (2-Day Zero Budget)

## Overview
**Timeline:** 2 days  
**Budget:** $0  
**Resources:** Gemini API key only  
**Goal:** Functional prototype demonstrating core concept

---

## Technical Stack (Free Tier Only)

### Frontend
- **Framework:** Next.js 14 (App Router)
- **Styling:** Tailwind CSS
- **Components:** shadcn/ui (free)
- **Icons:** Lucide React (free)

### Backend & Database
- **Database:** Supabase (free tier)
- **Authentication:** Supabase Auth
- **API:** Next.js API Routes
- **AI:** Google Gemini API

### Hosting & Infrastructure
- **Hosting:** Vercel (free tier)
- **Storage:** Supabase Storage (free tier)
- **Email:** Resend (free tier - 100 emails/day)
- **Payments:** Stripe (available)
- **Version Control:** GitHub (free)

---

## Simplified Architecture

```
┌──────────────────────────────────────┐
│      User Browser (Client)           │
│  Next.js App hosted on Vercel        │
└──────────────┬───────────────────────┘
               │
┌──────────────▼───────────────────────┐
│     Next.js API Routes               │
│  (Serverless functions)              │
└──────────────┬───────────────────────┘
               │
      ┌────────┴────────┐
      │                 │
┌─────▼─────┐    ┌────▼────┐
│ Supabase  │    │ Gemini  │
│  (DB)     │    │  API    │
└───────────┘    └─────────┘
```

---

## Core Features (MVP)

### 1. User Authentication
**Implementation:** Supabase Auth
- Email/password registration
- Email confirmation
- Session management
- Protected routes

### 2. Store Management
**Implementation:** Manual data entry
- Store creation form
- Basic store information
- Platform selection (dropdown)
- No actual API integration

### 3. Product Management
**Implementation:** Manual entry + AI generation
- Manual product entry form
- AI-generated descriptions (Gemini)
- AI-generated marketing copy
- Image upload (Supabase Storage)

### 4. Order Tracking
**Implementation:** Manual entry
- Manual order entry form
- Shipping deadline calculation
- Order status tracking
- Email deadline reminders

### 5. AI Content Generation
**Implementation:** Gemini API
- Product descriptions
- Marketing copy
- Social media content
- Store descriptions

---

## Database Schema (Simplified)

### Users Table
```sql
CREATE TABLE users (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  email TEXT UNIQUE NOT NULL,
  password_hash TEXT NOT NULL,
  name TEXT,
  created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
  updated_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

CREATE INDEX idx_users_email ON users(email);
```

### Stores Table
```sql
CREATE TABLE stores (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  platform TEXT NOT NULL, -- 'shopify', 'amazon', 'etsy', 'other'
  description TEXT,
  website_url TEXT,
  status TEXT DEFAULT 'active', -- 'active', 'inactive'
  created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
  updated_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

CREATE INDEX idx_stores_user_id ON stores(user_id);
CREATE INDEX idx_stores_platform ON stores(platform);
```

### Products Table
```sql
CREATE TABLE products (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  store_id UUID NOT NULL REFERENCES stores(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  description TEXT, -- AI-generated
  price DECIMAL(10,2) NOT NULL,
  currency TEXT DEFAULT 'USD',
  image_url TEXT,
  category TEXT,
  tags TEXT[], -- array of tags
  ai_generated_content JSONB, -- store AI-generated variations
  status TEXT DEFAULT 'active', -- 'active', 'inactive'
  created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
  updated_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

CREATE INDEX idx_products_store_id ON products(store_id);
CREATE INDEX idx_products_status ON products(status);
```

### Orders Table
```sql
CREATE TABLE orders (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  store_id UUID NOT NULL REFERENCES stores(id) ON DELETE CASCADE,
  customer_name TEXT NOT NULL,
  customer_email TEXT,
  customer_phone TEXT,
  total_amount DECIMAL(10,2) NOT NULL,
  currency TEXT DEFAULT 'USD',
  shipping_address JSONB, -- store full address as JSON
  shipping_deadline TIMESTAMP WITH TIME ZONE,
  status TEXT DEFAULT 'pending', -- 'pending', 'processing', 'shipped', 'delivered'
  notes TEXT,
  created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
  updated_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

CREATE INDEX idx_orders_store_id ON orders(store_id);
CREATE INDEX idx_orders_status ON orders(status);
CREATE INDEX idx_orders_shipping_deadline ON orders(shipping_deadline);
```

### AI_Generated_Content Table (Optional)
```sql
CREATE TABLE ai_generated_content (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  product_id UUID REFERENCES products(id) ON DELETE CASCADE,
  content_type TEXT NOT NULL, -- 'description', 'marketing', 'social'
  content TEXT NOT NULL,
  prompt_used TEXT,
  model_used TEXT DEFAULT 'gemini-pro',
  created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

CREATE INDEX idx_ai_content_product_id ON ai_generated_content(product_id);
CREATE INDEX idx_ai_content_type ON ai_generated_content(content_type);
```

---

## API Endpoints (Simplified)

### Authentication
```
POST /api/auth/register
POST /api/auth/login
POST /api/auth/logout
GET  /api/auth/user
```

### Payments
```
POST /api/payments/create-checkout-session
POST /api/payments/webhook
GET  /api/payments/subscription
```

### Stores
```
GET    /api/stores
POST   /api/stores
GET    /api/stores/:id
PUT    /api/stores/:id
DELETE /api/stores/:id
```

### Products
```
GET    /api/stores/:storeId/products
POST   /api/stores/:storeId/products
GET    /api/products/:id
PUT    /api/products/:id
DELETE /api/products/:id
POST   /api/products/:id/generate-description
POST   /api/products/:id/generate-marketing
```

### Orders
```
GET    /api/stores/:storeId/orders
POST   /api/stores/:storeId/orders
GET    /api/orders/:id
PUT    /api/orders/:id
DELETE /api/orders/:id
```

### AI Content
```
POST /api/ai/generate-description
POST /api/ai/generate-marketing
POST /api/ai/generate-social-content
```

---

## Gemini API Integration

### Configuration
```typescript
// lib/gemini.ts
import { GoogleGenerativeAI } from '@google/generative-ai';

const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY!);

export const geminiModel = genAI.getGenerativeModel({ 
  model: 'gemini-pro' 
});
```

### Product Description Generation
```typescript
export async function generateProductDescription(
  productName: string, 
  features: string[],
  targetAudience: string = 'general'
): Promise<string> {
  const prompt = `Generate a compelling, SEO-optimized product description for:
  
Product: ${productName}
Features: ${features.join(', ')}
Target Audience: ${targetAudience}

Requirements:
- Keep it under 200 words
- Include relevant keywords naturally
- Focus on benefits, not just features
- Make it persuasive and professional
- Include a call to action`;

  const result = await geminiModel.generateContent(prompt);
  return result.response.text();
}
```

### Marketing Content Generation
```typescript
export async function generateMarketingContent(
  productName: string,
  description: string,
  platform: 'instagram' | 'facebook' | 'twitter' | 'email'
): Promise<string> {
  const platformSpecific = {
    instagram: 'Create an Instagram caption with emojis and relevant hashtags',
    facebook: 'Create a Facebook post with engaging copy',
    twitter: 'Create a tweet under 280 characters with hashtags',
    email: 'Create email subject line and body copy'
  };

  const prompt = `${platformSpecific[platform]} for:

Product: ${productName}
Description: ${description}

Make it engaging, action-oriented, and relevant to the platform.`;

  const result = await geminiModel.generateContent(prompt);
  return result.response.text();
}
```

### Store Description Generation
```typescript
export async function generateStoreDescription(
  storeName: string,
  products: string[],
  businessType: string
): Promise<string> {
  const prompt = `Generate a professional store description for:

Store: ${storeName}
Products: ${products.join(', ')}
Business Type: ${businessType}

Requirements:
- Professional and trustworthy tone
- Highlight unique value proposition
- Keep it under 150 words
- Include what makes this store special`;

  const result = await geminiModel.generateContent(prompt);
  return result.response.text();
}
```

---

## Shipping Deadline Calculation

### Logic
```typescript
export function calculateShippingDeadline(
  orderDate: Date = new Date(),
  processingDays: number = 2,
  shippingBuffer: number = 1
): Date {
  const deadline = new Date(orderDate);
  let businessDaysAdded = 0;
  
  while (businessDaysAdded < processingDays + shippingBuffer) {
    deadline.setDate(deadline.getDate() + 1);
    const dayOfWeek = deadline.getDay();
    
    // Skip weekends (0 = Sunday, 6 = Saturday)
    if (dayOfWeek !== 0 && dayOfWeek !== 6) {
      businessDaysAdded++;
    }
  }
  
  // Set to end of business day (5 PM)
  deadline.setHours(17, 0, 0, 0);
  
  return deadline;
}
```

---

## Email Notifications

### Implementation: Resend API
```typescript
// lib/email.ts
import { Resend } from 'resend';

const resend = new Resend(process.env.RESEND_API_KEY);

export async function sendShippingDeadlineReminder(
  userEmail: string,
  orderId: string,
  deadline: Date
): Promise<void> {
  await resend.emails.send({
    from: 'noreply@autostore-mvp.vercel.app',
    to: userEmail,
    subject: 'Shipping Deadline Reminder',
    html: `
      <h2>Shipping Deadline Reminder</h2>
      <p>Order #${orderId} must be shipped by: ${deadline.toLocaleDateString()}</p>
      <p>Please ensure the order is processed and shipped on time.</p>
    `
  });
}
```

---

## Payment Processing

### Implementation: Stripe API
```typescript
// lib/stripe.ts
import Stripe from 'stripe';

const stripe = new Stripe(process.env.STRIPE_SECRET_KEY!);

export async function createCheckoutSession(
  userId: string,
  priceId: string
): Promise<string> {
  const session = await stripe.checkout.sessions.create({
    customer_email: userEmail,
    line_items: [
      {
        price: priceId,
        quantity: 1,
      },
    ],
    mode: 'subscription',
    success_url: `${process.env.NEXT_PUBLIC_APP_URL}/dashboard?success=true`,
    cancel_url: `${process.env.NEXT_PUBLIC_APP_URL}/pricing?canceled=true`,
  });

  return session.url!;
}

export async function handleWebhook(event: Stripe.Event): Promise<void> {
  switch (event.type) {
    case 'checkout.session.completed':
      // Handle subscription creation
      break;
    case 'invoice.paid':
      // Handle payment success
      break;
    case 'customer.subscription.deleted':
      // Handle subscription cancellation
      break;
  }
}
```

### Subscription Tiers
```typescript
const SUBSCRIPTION_PLANS = {
  starter: {
    name: 'Starter',
    priceId: process.env.STRIPE_STARTER_PRICE_ID,
    price: 49,
    features: ['Single platform', 'Basic automation', 'Email support']
  },
  growth: {
    name: 'Growth',
    priceId: process.env.STRIPE_GROWTH_PRICE_ID,
    price: 149,
    features: ['Multi-platform', 'Marketing automation', 'Priority support']
  }
};
```

---

## Frontend Components Structure

### Page Structure
```
app/
├── (auth)/
│   ├── login/
│   │   └── page.tsx
│   └── register/
│       └── page.tsx
├── dashboard/
│   ├── layout.tsx
│   ├── page.tsx
│   ├── stores/
│   │   ├── page.tsx
│   │   └── [id]/
│   │       └── page.tsx
│   ├── products/
│   │   ├── page.tsx
│   │   └── [id]/
│   │       └── page.tsx
│   └── orders/
│       ├── page.tsx
│       └── [id]/
│           └── page.tsx
├── api/
│   ├── auth/
│   ├── stores/
│   ├── products/
│   ├── orders/
│   └── ai/
└── page.tsx (landing page)
```

### Key Components
```typescript
// components/StoreForm.tsx
interface StoreFormProps {
  onSubmit: (data: StoreData) => void;
}

// components/ProductForm.tsx
interface ProductFormProps {
  storeId: string;
  onSubmit: (data: ProductData) => void;
}

// components/OrderForm.tsx
interface OrderFormProps {
  storeId: string;
  onSubmit: (data: OrderData) => void;
}

// components/AIContentGenerator.tsx
interface AIContentGeneratorProps {
  type: 'description' | 'marketing' | 'social';
  inputData: any;
  onGenerated: (content: string) => void;
}
```

---

## Environment Variables

```env
# Supabase
NEXT_PUBLIC_SUPABASE_URL=your_supabase_url
NEXT_PUBLIC_SUPABASE_ANON_KEY=your_supabase_anon_key

# Gemini API
GEMINI_API_KEY=your_gemini_api_key

# Resend (Email)
RESEND_API_KEY=your_resend_api_key

# Stripe
STRIPE_SECRET_KEY=your_stripe_secret_key
NEXT_PUBLIC_STRIPE_PUBLISHABLE_KEY=your_stripe_publishable_key
STRIPE_WEBHOOK_SECRET=your_stripe_webhook_secret

# App
NEXT_PUBLIC_APP_URL=https://your-app.vercel.app
```

---

## Deployment Steps

### 1. Set Up Projects
```bash
# Create Next.js app
npx create-next-app@latest autostore-mvp
cd autostore-mvp

# Install dependencies
npm install @supabase/supabase-js @google/generative-ai resend
npm install -D tailwindcss postcss autoprefixer
npx shadcn-ui@latest init
```

### 2. Set Up Supabase
- Create free project at supabase.com
- Run SQL schema in SQL editor
- Enable Auth
- Create storage bucket for images

### 3. Configure Environment
- Copy `.env.example` to `.env.local`
- Add all API keys
- Test connections

### 4. Deploy to Vercel
```bash
# Install Vercel CLI
npm i -g vercel

# Deploy
vercel
```

### 5. Post-Deployment
- Test all functionality
- Set up cron job for deadline reminders
- Monitor usage on all platforms
- Create user documentation

---

## Performance Considerations

### Client-Side
- Use React Query for data fetching
- Implement pagination for lists
- Lazy load images
- Cache API responses

### Server-Side
- Use Next.js caching where possible
- Implement rate limiting for Gemini API
- Optimize database queries
- Use CDN for static assets

### Database
- Create proper indexes
- Use connection pooling
- Monitor query performance
- Archive old data if needed

---

## Security Considerations

### Authentication
- Use Supabase Auth (handles most security)
- Implement protected routes
- Use HTTP-only cookies for sessions
- Validate all user inputs

### API Security
- Rate limit Gemini API calls
- Validate all request data
- Use environment variables for secrets
- Implement CORS properly

### Data Security
- Encrypt sensitive data at rest (Supabase handles this)
- Use HTTPS only (Vercel provides this)
- Implement proper access controls
- Regular security audits

---

## Monitoring & Logging

### Free Tools
- Vercel Analytics (built-in)
- Supabase Dashboard (built-in)
- Google Cloud Console (for Gemini API)
- Resend Dashboard (for emails)

### Key Metrics to Track
- User signups
- AI content generation usage
- Database query performance
- Email delivery rates
- Error rates

---

## Limitations & Known Issues

### Current Limitations
- Manual data entry only
- No real platform integrations
- Limited AI rate limits
- Email limits (100/day)
- Storage limits (1GB)
- Single developer only

### Known Issues
- No real-time order sync
- Manual order entry required
- Limited AI customization
- Basic UI only
- No mobile optimization

---

## Post-Launch Improvements

### Immediate (Week 1)
- Gather user feedback
- Fix critical bugs
- Improve AI prompts
- Add more content templates

### Short-term (Month 1)
- Add basic analytics
- Improve UI/UX
- Add more AI features
- Implement basic automation

### Long-term (When Funded)
- Real platform integrations
- Mobile apps
- Advanced AI features
- Marketing automation
- Full-scale deployment

---

## Success Criteria

### Technical Success
- [ ] Application deployed and accessible
- [ ] User authentication working
- [ ] AI content generation functional
- [ ] Email notifications working
- [ ] Database operations working

### User Success
- [ ] Users can register and login
- [ ] Users can create stores
- [ ] Users can add products
- [ ] AI generates useful content
- [ ] Users receive deadline reminders

### Business Validation
- [ ] Get 10 test users
- [ ] Collect feedback on AI quality
- [ ] Identify pain points
- [ ] Validate market interest
- [ ] Gather feature requests

---

## Emergency Fallbacks

### If Gemini API Fails
- Use pre-written templates
- Allow manual content entry
- Display clear error messages
- Implement retry logic

### If Supabase Fails
- Use local storage as fallback
- Implement error boundaries
- Provide clear error messages
- Have backup export function

### If Vercel Fails
- Deploy to Netlify (free)
- Use GitHub Pages (static only)
- Have local development ready

---

## Timeline Summary

### Day 1 (8 hours)
- **Morning (4h):** Setup, authentication, basic UI
- **Afternoon (4h):** Store/product forms, AI integration

### Day 2 (8 hours)
- **Morning (4h):** AI features, order tracking, email
- **Afternoon (4h):** Polish, testing, deployment

### Total Development Time: 16 hours

---

**Remember:** This is a functional prototype to demonstrate the concept. Focus on core functionality and user experience. Perfect is the enemy of done - get it working and iterate based on feedback.
