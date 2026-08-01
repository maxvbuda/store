# AutoStore AI - MVP Architecture (2-Day Implementation)

## Architecture Overview
**Simplified stack for rapid deployment with zero budget**

---

## System Architecture

```
┌─────────────────────────────────────────────────────────────┐
│                    User Layer                                 │
│  ┌───────────────────────────────────────────────────────┐  │
│  │           Web Browser (Client)                           │  │
│  │  Next.js 14 App hosted on Vercel (Free Tier)            │  │
│  │  - React Components                                      │  │
│  │  - Tailwind CSS + shadcn/ui                             │  │
│  │  - Client-side Routing                                  │  │
│  └───────────────────────────────────────────────────────┘  │
└────────────────────┬────────────────────────────────────────┘
                     │ HTTPS
┌────────────────────▼────────────────────────────────────────┐
│                  API Layer                                   │
│  ┌───────────────────────────────────────────────────────┐  │
│  │        Next.js API Routes (Serverless)                  │  │
│  │  - /api/auth/* (Authentication)                         │  │
│  │  - /api/stores/* (Store Management)                    │  │
│  │  - /api/products/* (Product Management)                │  │
│  │  - /api/orders/* (Order Management)                    │  │
│  │  - /api/ai/* (AI Content Generation)                   │  │
│  └───────────────────────────────────────────────────────┘  │
└────────────────────┬────────────────────────────────────────┘
                     │
        ┌────────────┴────────────┐
        │                         │
┌───────▼────────┐       ┌────────▼────────┐       ┌──────────┐
│   Supabase      │       │   Gemini API    │       │  Stripe  │
│   (Free Tier)   │       │   (Your Key)    │       │   API    │
├─────────────────┤       ├─────────────────┤       ├──────────┤
│ • PostgreSQL    │       │ • AI Content    │       │ • Paymens│
│ • Auth          │       │   Generation    │       │ • Subs   │
│ • Storage       │       │ • Text Models   │       │ • Webhook│
│ • Real-time     │       │ • Rate Limits   │       └──────────┘
└─────────────────┘       └─────────────────┘
```

---

## Technology Stack Details

### Frontend Layer
**Next.js 14 App Router**
- **Framework:** Next.js 14 with App Router
- **Styling:** Tailwind CSS
- **Components:** shadcn/ui (free component library)
- **Icons:** Lucide React
- **State Management:** React hooks + React Context
- **Deployment:** Vercel (free tier)

**Key Features:**
- Server-side rendering (SSR) for performance
- Static generation where possible
- API routes for backend logic
- File-based routing

### Backend Layer
**Next.js API Routes (Serverless Functions)**
- **Runtime:** Node.js 18+
- **Authentication:** Supabase Auth
- **Database:** Supabase PostgreSQL
- **AI Integration:** Google Gemini API
- **Email:** Resend API (free tier)
- **Payments:** Stripe API

**API Structure:**
```
/api/
├── auth/
│   ├── register/route.ts
│   ├── login/route.ts
│   └── logout/route.ts
├── stores/
│   ├── route.ts (GET, POST)
│   └── [id]/route.ts (GET, PUT, DELETE)
├── products/
│   ├── route.ts (GET, POST)
│   └── [id]/route.ts (GET, PUT, DELETE)
├── orders/
│   ├── route.ts (GET, POST)
│   └── [id]/route.ts (GET, PUT, DELETE)
└── ai/
    ├── generate-description/route.ts
    ├── generate-marketing/route.ts
    └── generate-social/route.ts
```

### Data Layer
**Supabase (Free Tier)**
- **Database:** PostgreSQL (500MB limit)
- **Authentication:** Built-in Auth system
- **Storage:** 1GB for images/files
- **Real-time:** WebSocket subscriptions
- **REST API:** Auto-generated REST API

**Connection:**
```typescript
// lib/supabase.ts
import { createClient } from '@supabase/supabase-js';

const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL!;
const supabaseKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!;

export const supabase = createClient(supabaseUrl, supabaseKey);
```

### AI Layer
**Google Gemini API**
- **Model:** gemini-pro (text generation)
- **Rate Limits:** 15 requests/minute
- **Cost:** Free tier available
- **Use Cases:** Content generation, copywriting

**Implementation:**
```typescript
// lib/gemini.ts
import { GoogleGenerativeAI } from '@google/generative-ai';

const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY!);
export const model = genAI.getGenerativeModel({ model: 'gemini-pro' });
```

### Email Layer
**Resend (Free Tier)**
- **Limit:** 100 emails/day
- **Features:** Transactional emails
- **Templates:** HTML email support
- **Analytics:** Basic delivery tracking

**Implementation:**
```typescript
// lib/email.ts
import { Resend } from 'resend';

const resend = new Resend(process.env.RESEND_API_KEY!);

export async function sendEmail(to: string, subject: string, html: string) {
  await resend.emails.send({
    from: 'noreply@your-app.vercel.app',
    to,
    subject,
    html
  });
}
```

---

## Data Flow Diagrams

### User Registration Flow
```
┌──────────┐
│  User    │
│  Browser │
└────┬─────┘
     │ Register
     ▼
┌─────────────────┐
│ /api/auth/      │
│ register        │
│ (Next.js API)   │
└────┬────────────┘
     │
     ▼
┌─────────────────┐
│ Supabase Auth   │
│ - Create User   │
│ - Hash Password │
│ - Send Email    │
└────┬────────────┘
     │
     ▼
┌─────────────────┐
│ Database        │
│ - Insert User   │
└────┬────────────┘
     │
     ▼
┌──────────┐
│ Success │
│ Response│
└──────────┘
```

### Product Creation with AI Flow
```
┌──────────┐
│  User    │
│  Browser │
└────┬─────┘
     │ Add Product
     ▼
┌─────────────────┐
│ Product Form    │
│ - Basic Info    │
│ - Features      │
└────┬────────────┘
     │
     ▼
┌─────────────────┐
│ /api/products/  │
│ generate-desc   │
│ (Next.js API)   │
└────┬────────────┘
     │
     ├──────────────┐
     ▼              ▼
┌─────────┐  ┌────────────┐
│Supabase │  │  Gemini    │
│  DB     │  │   API      │
└────┬────┘  └─────┬──────┘
     │             │
     │ AI Content  │
     └──────┬──────┘
            ▼
     ┌────────────┐
     │ Combine    │
     │ Data + AI  │
     └─────┬──────┘
           ▼
     ┌────────────┐
     │ Save to DB │
     └─────┬──────┘
           ▼
     ┌────────────┐
     │ Success    │
     │ Response   │
     └────────────┘
```

### Order Tracking & Deadline Flow
```
┌──────────┐
│  User    │
│  Browser │
└────┬─────┘
     │ Add Order
     ▼
┌─────────────────┐
│ Order Form      │
│ - Customer Info │
│ - Order Details │
└────┬────────────┘
     │
     ▼
┌─────────────────┐
│ /api/orders/    │
│ (Next.js API)   │
└────┬────────────┘
     │
     ▼
┌─────────────────┐
│ Calculate       │
│ Shipping        │
│ Deadline        │
└────┬────────────┘
     │
     ▼
┌─────────────────┐
│ Save to DB     │
│ + Schedule     │
│ Email Reminder │
└────┬────────────┘
     │
     ▼
┌─────────────────┐
│ Success        │
│ Response       │
└─────────────────┘
     │
     │ (Later)
     ▼
┌─────────────────┐
│ Cron Job /      │
│ Vercel Cron     │
└────┬────────────┘
     │ Check Deadlines
     ▼
┌─────────────────┐
│ Send Email      │
│ Reminders       │
└─────────────────┘
```

---

## Component Architecture

### Frontend Components
```
components/
├── ui/                    # shadcn/ui components
│   ├── button.tsx
│   ├── input.tsx
│   ├── form.tsx
│   └── ...
├── auth/
│   ├── LoginForm.tsx
│   └── RegisterForm.tsx
├── dashboard/
│   ├── DashboardLayout.tsx
│   ├── StoreCard.tsx
│   └── StatsCard.tsx
├── stores/
│   ├── StoreForm.tsx
│   ├── StoreList.tsx
│   └── StoreDetail.tsx
├── products/
│   ├── ProductForm.tsx
│   ├── ProductList.tsx
│   ├── ProductCard.tsx
│   └── AIContentGenerator.tsx
├── orders/
│   ├── OrderForm.tsx
│   ├── OrderList.tsx
│   └── OrderCard.tsx
└── shared/
    ├── LoadingSpinner.tsx
    ├── ErrorBoundary.tsx
    └── Notification.tsx
```

### Page Structure
```
app/
├── layout.tsx              # Root layout
├── page.tsx               # Landing page
├── (auth)/
│   ├── layout.tsx         # Auth layout
│   ├── login/
│   │   └── page.tsx
│   └── register/
│       └── page.tsx
├── dashboard/
│   ├── layout.tsx         # Dashboard layout
│   ├── page.tsx           # Dashboard home
│   ├── stores/
│   │   ├── page.tsx       # Store list
│   │   └── [id]/
│   │       └── page.tsx   # Store detail
│   ├── products/
│   │   ├── page.tsx       # Product list
│   │   └── [id]/
│   │       └── page.tsx   # Product detail
│   └── orders/
│       ├── page.tsx       # Order list
│       └── [id]/
│           └── page.tsx   # Order detail
└── api/                   # API routes
    └── (as shown above)
```

---

## Database Schema Implementation

### Supabase SQL Setup
```sql
-- Enable UUID extension
CREATE EXTENSION IF NOT EXISTS "uuid-ossp";

-- Users table (managed by Supabase Auth)
-- auth.users is created automatically

-- Create custom profiles table
CREATE TABLE public.profiles (
  id UUID REFERENCES auth.users(id) PRIMARY KEY,
  email TEXT,
  full_name TEXT,
  avatar_url TEXT,
  created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
  updated_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

-- Stores table
CREATE TABLE public.stores (
  id UUID DEFAULT uuid_generate_v4() PRIMARY KEY,
  user_id UUID REFERENCES public.profiles(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  platform TEXT NOT NULL,
  description TEXT,
  website_url TEXT,
  status TEXT DEFAULT 'active',
  created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
  updated_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

-- Products table
CREATE TABLE public.products (
  id UUID DEFAULT uuid_generate_v4() PRIMARY KEY,
  store_id UUID REFERENCES public.stores(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  description TEXT,
  price DECIMAL(10,2) NOT NULL,
  currency TEXT DEFAULT 'USD',
  image_url TEXT,
  category TEXT,
  tags TEXT[] DEFAULT '{}',
  ai_generated_content JSONB DEFAULT '{}',
  status TEXT DEFAULT 'active',
  created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
  updated_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

-- Orders table
CREATE TABLE public.orders (
  id UUID DEFAULT uuid_generate_v4() PRIMARY KEY,
  store_id UUID REFERENCES public.stores(id) ON DELETE CASCADE,
  customer_name TEXT NOT NULL,
  customer_email TEXT,
  customer_phone TEXT,
  total_amount DECIMAL(10,2) NOT NULL,
  currency TEXT DEFAULT 'USD',
  shipping_address JSONB,
  shipping_deadline TIMESTAMP WITH TIME ZONE,
  status TEXT DEFAULT 'pending',
  notes TEXT,
  created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
  updated_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

-- Create indexes
CREATE INDEX idx_stores_user_id ON public.stores(user_id);
CREATE INDEX idx_products_store_id ON public.products(store_id);
CREATE INDEX idx_orders_store_id ON public.orders(store_id);
CREATE INDEX idx_orders_shipping_deadline ON public.orders(shipping_deadline);

-- Enable Row Level Security
ALTER TABLE public.profiles ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.stores ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.products ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.orders ENABLE ROW LEVEL SECURITY;

-- Create RLS policies
CREATE POLICY "Users can view own profile" ON public.profiles
  FOR SELECT USING (auth.uid() = id);

CREATE POLICY "Users can update own profile" ON public.profiles
  FOR UPDATE USING (auth.uid() = id);

CREATE POLICY "Users can view own stores" ON public.stores
  FOR SELECT USING (auth.uid() = user_id);

CREATE POLICY "Users can create own stores" ON public.stores
  FOR INSERT WITH CHECK (auth.uid() = user_id);

CREATE POLICY "Users can update own stores" ON public.stores
  FOR UPDATE USING (auth.uid() = user_id);

-- Similar policies for products and orders...
```

---

## Security Architecture

### Authentication Flow
```
┌──────────┐
│  User    │
│  Browser │
└────┬─────┘
     │ Login Request
     ▼
┌─────────────────┐
│ Supabase Auth   │
│ - Validate     │
│ - Create JWT   │
└────┬────────────┘
     │
     ▼
┌─────────────────┐
│ Set HTTP-only   │
│ Cookie          │
└────┬────────────┘
     │
     ▼
┌─────────────────┐
│ Redirect to     │
│ Dashboard       │
└─────────────────┘
```

### Data Security
- **Row Level Security (RLS):** Database-level access control
- **JWT Authentication:** Supabase manages tokens
- **HTTPS Only:** Vercel provides SSL
- **Environment Variables:** Secrets stored securely
- **Input Validation:** All inputs validated on both client and server

---

## Performance Optimization

### Client-Side Optimization
- **Code Splitting:** Next.js automatic code splitting
- **Image Optimization:** Next.js Image component
- **Lazy Loading:** React.lazy for components
- **Caching:** React Query for data caching

### Server-Side Optimization
- **Edge Caching:** Vercel Edge Network
- **API Route Caching:** Next.js cache helper
- **Database Indexing:** Proper indexes on frequently queried columns
- **Connection Pooling:** Supabase manages connections

### AI API Optimization
- **Rate Limiting:** Implement client-side rate limiting
- **Caching:** Cache AI-generated content
- **Batch Processing:** Combine requests when possible
- **Fallback Templates:** Pre-written content if API fails

---

## Deployment Architecture

### Vercel Deployment
```
GitHub Repository
       │
       │ Push
       ▼
Vercel (Automatic Deploy)
       │
       ├─→ Build Next.js App
       ├─→ Run Tests (if configured)
       ├─→ Deploy to Edge Network
       └─→ Update DNS
```

### Environment Variables
```env
# Supabase
NEXT_PUBLIC_SUPABASE_URL=your-project.supabase.co
NEXT_PUBLIC_SUPABASE_ANON_KEY=your-anon-key

# Gemini API
GEMINI_API_KEY=your-gemini-key

# Resend
RESEND_API_KEY=your-resend-key

# App
NEXT_PUBLIC_APP_URL=https://your-app.vercel.app
```

### Continuous Deployment
- **Automatic:** Every push to main branch
- **Preview Deployments:** Every pull request
- **Rollback:** One-click rollback to previous deployments
- **Zero Downtime:** Vercel handles seamless deployments

---

## Monitoring & Debugging

### Free Monitoring Tools
- **Vercel Analytics:** Built-in performance monitoring
- **Supabase Dashboard:** Database performance and logs
- **Google Cloud Console:** Gemini API usage
- **Resend Dashboard:** Email delivery logs
- **Browser DevTools:** Client-side debugging

### Key Metrics to Monitor
- Page load times
- API response times
- Database query performance
- AI API usage and rate limits
- Email delivery rates
- Error rates

---

## Scalability Considerations

### Current Limitations (Free Tier)
- **Vercel:** 100GB bandwidth/month
- **Supabase:** 500MB database, 1GB storage
- **Gemini:** 15 requests/minute
- **Resend:** 100 emails/day

### Scaling Path (When Funded)
- **Upgrade Vercel Plan:** Higher bandwidth and execution time
- **Supabase Pro:** Larger database and storage
- **Gemini Pro:** Higher rate limits and better models
- **Dedicated Email Service:** SendGrid, Mailgun
- **CDN:** Cloudflare for global distribution
- **Load Balancing:** Multiple server instances

---

## Error Handling Strategy

### Client-Side Errors
- **Error Boundaries:** Catch React errors
- **Toast Notifications:** User-friendly error messages
- **Form Validation:** Prevent invalid submissions
- **Retry Logic:** Automatic retry for failed requests

### Server-Side Errors
- **Try-Catch Blocks:** Wrap all API route logic
- **Error Logging:** Log errors for debugging
- **Graceful Degradation:** Fallback functionality
- **Status Codes:** Proper HTTP status codes

### External API Errors
- **Retry with Exponential Backoff:** Handle rate limits
- **Fallback Content:** Pre-written templates
- **Circuit Breaker:** Stop calling failing APIs
- **User Notifications:** Clear error messages

---

## Backup & Recovery

### Data Backup
- **Supabase:** Automatic daily backups (free tier)
- **Export Functions:** Manual data export capability
- **Database Snapshots:** Point-in-time recovery

### Disaster Recovery
- **Git Repository:** Code backup
- **Environment Variables:** Secure storage
- **Documentation:** Setup and recovery procedures
- **Local Development:** Can run locally if needed

---

## Development Workflow

### Local Development
```bash
# Install dependencies
npm install

# Run development server
npm run dev

# Run on http://localhost:3000
```

### Git Workflow
```bash
# Create feature branch
git checkout -b feature/new-feature

# Make changes and commit
git add .
git commit -m "Add new feature"

# Push to GitHub
git push origin feature/new-feature

# Create pull request on GitHub
# Vercel automatically creates preview deployment
```

### Testing Strategy
- **Manual Testing:** Critical user flows
- **API Testing:** Test API endpoints with Postman
- **Database Testing:** Verify Supabase operations
- **AI Testing:** Test Gemini API integration

---

## Known Limitations

### Technical Limitations
- No real-time order synchronization
- Manual data entry required
- Limited AI customization
- Basic UI only
- No mobile optimization
- Single developer capacity

### Business Limitations
- No actual platform integrations
- Manual copy-paste to platforms
- Limited automation
- Basic analytics only
- No payment processing
- Manual customer communication

---

## Success Metrics

### Technical Success
- Application loads under 3 seconds
- API response time under 500ms
- Error rate under 5%
- 99% uptime (Vercel SLA)

### User Success
- Users can complete core flows in under 2 minutes
- AI content generation works 90% of the time
- Email notifications deliver 95% of the time
- User satisfaction score 4/5

### Business Validation
- 10 test users acquired
- AI content quality rated 3.5/5
- Users request platform integrations
- Feature requests collected
- Market interest validated

---

**This architecture prioritizes speed of implementation and cost efficiency over scalability and advanced features. It's designed to get a functional prototype deployed in 2 days to validate the core concept.**
