# AutoStore AI - Gemini API Integration Strategy

## Overview
**Primary AI Resource:** Google Gemini API  
**Model:** gemini-pro (text generation)  
**Constraints:** Free tier rate limits (15 requests/minute)  
**Purpose:** Content generation for e-commerce

---

## Gemini API Capabilities

### Available Models
- **gemini-pro:** General purpose text generation
- **gemini-pro-vision:** Multimodal (text + images)
- **gemini-1.5-pro:** Latest model (if available)

### Rate Limits (Free Tier)
- **gemini-pro:** 15 requests/minute
- **gemini-pro-vision:** 15 requests/minute
- **Daily limits:** Varies by region
- **Cost:** Free tier available, then pay-per-use

### Use Cases for MVP
1. Product description generation
2. Marketing content creation
3. Social media content
4. Store description writing
5. Email copy generation

---

## Integration Architecture

### Setup and Configuration
```typescript
// lib/gemini.ts
import { GoogleGenerativeAI } from '@google/generative-ai';

class GeminiAI {
  private genAI: GoogleGenerativeAI;
  private model: any;
  private requestCount: number = 0;
  private lastRequestTime: number = 0;
  private readonly RATE_LIMIT_DELAY = 4000; // 4 seconds between requests

  constructor() {
    const apiKey = process.env.GEMINI_API_KEY;
    if (!apiKey) {
      throw new Error('GEMINI_API_KEY is not defined');
    }
    
    this.genAI = new GoogleGenerativeAI(apiKey);
    this.model = this.genAI.getGenerativeModel({ model: 'gemini-pro' });
  }

  private async rateLimitDelay() {
    const now = Date.now();
    const timeSinceLastRequest = now - this.lastRequestTime;
    
    if (timeSinceLastRequest < this.RATE_LIMIT_DELAY) {
      const delayTime = this.RATE_LIMIT_DELAY - timeSinceLastRequest;
      await new Promise(resolve => setTimeout(resolve, delayTime));
    }
    
    this.lastRequestTime = Date.now();
    this.requestCount++;
  }

  async generateContent(prompt: string): Promise<string> {
    await this.rateLimitDelay();
    
    try {
      const result = await this.model.generateContent(prompt);
      const response = await result.response;
      return response.text();
    } catch (error) {
      console.error('Gemini API Error:', error);
      throw new Error('Failed to generate content with Gemini API');
    }
  }
}

export const geminiAI = new GeminiAI();
```

---

## Content Generation Strategies

### 1. Product Description Generation

#### Prompt Engineering
```typescript
export async function generateProductDescription(params: {
  productName: string;
  features: string[];
  targetAudience?: string;
  tone?: 'professional' | 'casual' | 'luxury' | 'friendly';
  maxLength?: number;
}): Promise<string> {
  const {
    productName,
    features,
    targetAudience = 'general consumers',
    tone = 'professional',
    maxLength = 200
  } = params;

  const toneInstructions = {
    professional: 'Use professional, business-oriented language',
    casual: 'Use friendly, conversational language',
    luxury: 'Use sophisticated, premium language',
    friendly: 'Use warm, approachable language'
  };

  const prompt = `Generate a compelling, SEO-optimized product description for:

Product: ${productName}
Features: ${features.join(', ')}
Target Audience: ${targetAudience}

Requirements:
- ${toneInstructions[tone]}
- Keep it under ${maxLength} words
- Include relevant keywords naturally
- Focus on benefits, not just features
- Make it persuasive and conversion-oriented
- Include a subtle call to action
- Structure: Hook → Features → Benefits → CTA

Format: Return only the description, no additional text.`;

  return await geminiAI.generateContent(prompt);
}
```

#### Usage Example
```typescript
const description = await generateProductDescription({
  productName: 'Ergonomic Office Chair',
  features: ['Lumbar support', 'Adjustable height', 'Breathable mesh', '360° swivel'],
  targetAudience: 'remote workers and office professionals',
  tone: 'professional',
  maxLength: 150
});
```

### 2. Marketing Content Generation

#### Social Media Content
```typescript
export async function generateSocialMediaContent(params: {
  productName: string;
  description: string;
  platform: 'instagram' | 'facebook' | 'twitter' | 'linkedin' | 'tiktok';
  includeHashtags: boolean;
  includeEmojis: boolean;
}): Promise<{
  content: string;
  hashtags: string[];
  suggestedImagePrompt?: string;
}> {
  const { productName, description, platform, includeHashtags, includeEmojis } = params;

  const platformSpecs = {
    instagram: {
      length: 2200,
      style: 'visual and engaging',
      hashtagCount: 15,
      emojiStyle: 'trendy and expressive'
    },
    facebook: {
      length: 63206,
      style: 'conversational and community-focused',
      hashtagCount: 5,
      emojiStyle: 'moderate and relevant'
    },
    twitter: {
      length: 280,
      style: 'concise and punchy',
      hashtagCount: 3,
      emojiStyle: 'minimal and strategic'
    },
    linkedin: {
      length: 3000,
      style: 'professional and value-driven',
      hashtagCount: 5,
      emojiStyle: 'professional and relevant'
    },
    tiktok: {
      length: 150,
      style: 'trendy and Gen-Z focused',
      hashtagCount: 8,
      emojiStyle: 'abundant and trendy'
    }
  };

  const spec = platformSpecs[platform];
  const emojiInstruction = includeEmojis ? `Use ${spec.emojiStyle} emojis` : 'No emojis';
  const hashtagInstruction = includeHashtags ? `Include ${spec.hashtagCount} relevant hashtags` : 'No hashtags';

  const prompt = `Generate ${platform} social media content for:

Product: ${productName}
Description: ${description}

Requirements:
- ${spec.style}
- Maximum ${spec.length} characters
- ${emojiInstruction}
- ${hashtagInstruction}
- Include a clear call to action
- Make it shareable and engaging

Format: Return the content followed by hashtags on separate lines. If including image suggestions, add "IMAGE_PROMPT: " followed by a brief description.`;

  const response = await geminiAI.generateContent(prompt);
  
  // Parse response
  const lines = response.split('\n').filter(line => line.trim());
  const content = lines[0];
  const hashtags = includeHashtags 
    ? lines.filter(line => line.startsWith('#')).map(tag => tag.trim())
    : [];
  const imagePrompt = lines.find(line => line.startsWith('IMAGE_PROMPT:'))?.replace('IMAGE_PROMPT:', '').trim();

  return { content, hashtags, suggestedImagePrompt: imagePrompt };
}
```

#### Email Marketing Copy
```typescript
export async function generateEmailMarketing(params: {
  productName: string;
  description: string;
  discount?: number;
  urgencyLevel?: 'low' | 'medium' | 'high';
  targetAudience?: string;
}): Promise<{
  subjectLine: string;
  previewText: string;
  bodyContent: string;
  ctaText: string;
}> {
  const {
    productName,
    description,
    discount,
    urgencyLevel = 'medium',
    targetAudience = 'customers'
  } = params;

  const urgencyPhrases = {
    low: 'Special offer available',
    medium: 'Limited time offer',
    high: 'Last chance - ending soon'
  };

  const discountText = discount ? `${discount}% discount` : 'exclusive access';

  const prompt = `Generate email marketing copy for:

Product: ${productName}
Description: ${description}
Offer: ${discountText}
Urgency: ${urgencyPhrases[urgencyLevel]}
Audience: ${targetAudience}

Requirements:
- Compelling subject line under 50 characters
- Engaging preview text under 100 characters
- Professional yet conversational body copy
- Clear, action-oriented call to action
- Focus on benefits and scarcity
- Mobile-friendly formatting

Format: Return as JSON with keys: subjectLine, previewText, bodyContent, ctaText`;

  const response = await geminiAI.generateContent(prompt);
  
  try {
    return JSON.parse(response);
  } catch {
    // Fallback parsing if JSON parsing fails
    return {
      subjectLine: `Special Offer: ${productName}`,
      previewText: urgencyPhrases[urgencyLevel],
      bodyContent: response,
      ctaText: 'Shop Now'
    };
  }
}
```

### 3. Store Description Generation

```typescript
export async function generateStoreDescription(params: {
  storeName: string;
  products: string[];
  businessType: string;
  uniqueValueProp?: string;
  targetAudience?: string;
}): Promise<string> {
  const {
    storeName,
    products,
    businessType,
    uniqueValueProp,
    targetAudience = 'quality-conscious customers'
  } = params;

  const uvpText = uniqueValueProp 
    ? `Unique Value: ${uniqueValueProp}`
    : 'Focus on quality and customer satisfaction';

  const prompt = `Generate a professional, trustworthy store description for:

Store: ${storeName}
Products: ${products.join(', ')}
Business Type: ${businessType}
${uvpText}
Target Audience: ${targetAudience}

Requirements:
- Professional and established tone
- Build trust and credibility
- Highlight unique value proposition
- Keep it under 150 words
- Include what makes this store special
- Mention commitment to quality/service
- End with a welcoming statement

Format: Return only the store description, no additional text.`;

  return await geminiAI.generateContent(prompt);
}
```

### 4. Ad Copy Generation

```typescript
export async function generateAdCopy(params: {
  productName: string;
  description: string;
  platform: 'google' | 'facebook' | 'instagram';
  adType?: 'search' | 'display' | 'social';
  targetAudience?: string;
}): Promise<{
  headline: string;
  description: string;
  displayUrl?: string;
}> {
  const {
    productName,
    description,
    platform,
    adType = 'social',
    targetAudience = 'potential customers'
  } = params;

  const platformSpecs = {
    google: {
      headlineLength: 30,
      descriptionLength: 90,
      style: 'keyword-focused and direct'
    },
    facebook: {
      headlineLength: 25,
      descriptionLength: 125,
      style: 'engaging and social'
    },
    instagram: {
      headlineLength: 125,
      descriptionLength: 2200,
      style: 'visual and lifestyle-oriented'
    }
  };

  const spec = platformSpecs[platform];

  const prompt = `Generate ${platform} ${adType} ad copy for:

Product: ${productName}
Description: ${description}
Target Audience: ${targetAudience}

Requirements:
- ${spec.style}
- Headline under ${spec.headlineLength} characters
- Description under ${spec.descriptionLength} characters
- Include clear value proposition
- Strong call to action
- Comply with ${platform} ad guidelines

Format: Return as JSON with keys: headline, description${platform === 'google' ? ', displayUrl' : ''}`;

  const response = await geminiAI.generateContent(prompt);
  
  try {
    return JSON.parse(response);
  } catch {
    return {
      headline: `Buy ${productName}`,
      description: response.substring(0, spec.descriptionLength),
      displayUrl: platform === 'google' ? 'yourstore.com/product' : undefined
    };
  }
}
```

---

## Caching Strategy

### Response Caching
```typescript
// lib/cache.ts
class ContentCache {
  private cache: Map<string, { content: string; timestamp: number }> = new Map();
  private readonly CACHE_DURATION = 24 * 60 * 60 * 1000; // 24 hours

  generateKey(params: any): string {
    return JSON.stringify(params);
  }

  get(key: string): string | null {
    const cached = this.cache.get(key);
    if (!cached) return null;
    
    const age = Date.now() - cached.timestamp;
    if (age > this.CACHE_DURATION) {
      this.cache.delete(key);
      return null;
    }
    
    return cached.content;
  }

  set(key: string, content: string): void {
    this.cache.set(key, {
      content,
      timestamp: Date.now()
    });
  }

  clear(): void {
    this.cache.clear();
  }
}

export const contentCache = new ContentCache();
```

### Cached AI Function
```typescript
export async function generateWithCache<T>(
  params: T,
  generator: (params: T) => Promise<string>
): Promise<string> {
  const cacheKey = contentCache.generateKey(params);
  
  // Check cache first
  const cached = contentCache.get(cacheKey);
  if (cached) {
    return cached;
  }
  
  // Generate new content
  const content = await generator(params);
  
  // Cache the result
  contentCache.set(cacheKey, content);
  
  return content;
}
```

---

## Fallback Content Templates

### Pre-Written Templates
```typescript
// lib/fallback-templates.ts
export const fallbackTemplates = {
  productDescriptions: {
    professional: `Experience quality and innovation with {productName}. Designed for {targetAudience}, this product delivers exceptional performance and reliability. Key features include {features} that enhance your daily experience. Upgrade today and discover the difference.`,

    casual: `Hey there! Check out {productName} - it's perfect for {targetAudience}. With {features}, you'll love how this fits into your lifestyle. Great quality, great price. What more could you ask for?`,

    luxury: `Indulge in the epitome of sophistication with {productName}. Meticulously crafted for {targetAudience}, this masterpiece features {features}. Elevate your experience with uncompromising quality and timeless elegance.`,

    friendly: `We're excited to introduce {productName}! Perfect for {targetAudience}, this amazing product includes {features}. We think you're going to love it as much as we do!`
  },

  socialMedia: {
    instagram: `✨ Introducing {productName}! ✨\n\n{description}\n\n🔗 Link in bio\n\n{hashtags}`,

    twitter: `🚀 New arrival: {productName}\n\n{description}\n\nShop now! {hashtags}`,

    facebook: `🎉 We're thrilled to announce {productName}!\n\n{description}\n\nPerfect for {targetAudience}. Get yours today!`,

    linkedin: `Excited to launch {productName} - designed for {targetAudience}. Featuring {features}, this innovation delivers exceptional value. Learn more about how it can benefit you.`
  },

  emailMarketing: {
    subjectLine: `Special Offer: {productName}`,
    previewText: `Don't miss out on this exclusive deal`,
    bodyContent: `Dear Customer,\n\nWe're excited to offer you an exclusive deal on {productName}.\n\n{description}\n\nThis is a limited-time offer, so don't miss out!\n\nBest regards,\nThe Team`,
    ctaText: `Shop Now`
  }
};

export function getFallbackTemplate(type: keyof typeof fallbackTemplates, subtype: string, params: any): string {
  const template = fallbackTemplates[type][subtype as keyof typeof fallbackTemplates[typeof type]];
  if (!template) return fallbackTemplates[type][Object.keys(fallbackTemplates[type])[0]];
  
  return template.replace(/\{(\w+)\}/g, (match, key) => params[key] || match);
}
```

---

## Error Handling & Retry Logic

### Exponential Backoff
```typescript
export async function generateWithRetry<T>(
  generator: () => Promise<T>,
  maxRetries: number = 3,
  baseDelay: number = 1000
): Promise<T> {
  for (let attempt = 0; attempt < maxRetries; attempt++) {
    try {
      return await generator();
    } catch (error) {
      if (attempt === maxRetries - 1) throw error;
      
      const delay = baseDelay * Math.pow(2, attempt);
      console.log(`Retry attempt ${attempt + 1} after ${delay}ms`);
      await new Promise(resolve => setTimeout(resolve, delay));
    }
  }
  throw new Error('Max retries exceeded');
}
```

### Error Types Handling
```typescript
export class GeminiAPIError extends Error {
  constructor(
    message: string,
    public type: 'rate_limit' | 'quota_exceeded' | 'invalid_request' | 'server_error' | 'unknown'
  ) {
    super(message);
    this.name = 'GeminiAPIError';
  }
}

export function handleGeminiError(error: any): GeminiAPIError {
  if (error.status === 429) {
    return new GeminiAPIError('Rate limit exceeded', 'rate_limit');
  }
  if (error.status === 400) {
    return new GeminiAPIError('Invalid request', 'invalid_request');
  }
  if (error.status >= 500) {
    return new GeminiAPIError('Server error', 'server_error');
  }
  return new GeminiAPIError('Unknown error', 'unknown');
}
```

---

## Usage Monitoring

### Track API Usage
```typescript
class GeminiUsageTracker {
  private dailyRequests: Map<string, number> = new Map();
  private dailyErrors: Map<string, number> = new Map();

  trackRequest(): void {
    const today = new Date().toDateString();
    this.dailyRequests.set(today, (this.dailyRequests.get(today) || 0) + 1);
  }

  trackError(): void {
    const today = new Date().toDateString();
    this.dailyErrors.set(today, (this.dailyErrors.get(today) || 0) + 1);
  }

  getDailyStats(date: Date = new Date()) {
    const dateString = date.toDateString();
    return {
      requests: this.dailyRequests.get(dateString) || 0,
      errors: this.dailyErrors.get(dateString) || 0
    };
  }

  isNearLimit(): boolean {
    const stats = this.getDailyStats();
    return stats.requests > 10; // Warn if near 15 request limit
  }
}

export const usageTracker = new GeminiUsageTracker();
```

---

## Integration Example

### Complete API Route
```typescript
// app/api/ai/generate-description/route.ts
import { NextRequest, NextResponse } from 'next/server';
import { generateProductDescription } from '@/lib/gemini';
import { generateWithRetry, handleGeminiError } from '@/lib/gemini-utils';
import { getFallbackTemplate } from '@/lib/fallback-templates';

export async function POST(request: NextRequest) {
  try {
    const body = await request.json();
    const { productName, features, targetAudience, tone } = body;

    // Validate input
    if (!productName || !features) {
      return NextResponse.json(
        { error: 'Missing required fields' },
        { status: 400 }
      );
    }

    // Generate with retry and fallback
    const description = await generateWithRetry(
      () => generateProductDescription({
        productName,
        features,
        targetAudience,
        tone
      })
    ).catch(async (error) => {
      console.error('Gemini API failed, using fallback:', error);
      
      // Use fallback template
      return getFallbackTemplate('productDescriptions', tone || 'professional', {
        productName,
        targetAudience: targetAudience || 'customers',
        features: features.join(', ')
      });
    });

    return NextResponse.json({ description });
  } catch (error) {
    console.error('API Error:', error);
    return NextResponse.json(
      { error: 'Failed to generate description' },
      { status: 500 }
    );
  }
}
```

---

## Best Practices

### 1. Prompt Engineering
- Be specific and clear in prompts
- Provide context and examples
- Set clear constraints (length, style)
- Use consistent formatting

### 2. Rate Limit Management
- Implement client-side rate limiting
- Use caching to reduce API calls
- Batch requests when possible
- Monitor usage regularly

### 3. Error Handling
- Always have fallback content
- Implement retry logic with backoff
- Log errors for debugging
- Provide user feedback

### 4. Content Quality
- Review and curate AI outputs
- Provide feedback loops
- A/B test different prompts
- Continuously improve prompts

### 5. Cost Management
- Monitor usage against limits
- Use caching aggressively
- Implement request queuing
- Set up alerts for limits

---

## Testing Strategy

### Unit Tests
```typescript
// __tests__/gemini.test.ts
describe('Gemini Integration', () => {
  test('generates product description', async () => {
    const description = await generateProductDescription({
      productName: 'Test Product',
      features: ['Feature 1', 'Feature 2']
    });
    
    expect(description).toBeTruthy();
    expect(description.length).toBeGreaterThan(50);
  });

  test('handles rate limiting', async () => {
    // Test rate limiting logic
  });

  test('fallback templates work', () => {
    const fallback = getFallbackTemplate('productDescriptions', 'professional', {
      productName: 'Test',
      targetAudience: 'Customers',
      features: 'Features'
    });
    
    expect(fallback).toContain('Test');
  });
});
```

---

## Future Enhancements

### When Budget Allows
1. **Upgrade to Gemini Pro:** Better quality, higher limits
2. **Fine-tuning:** Custom models for specific use cases
3. **Image Generation:** Add image generation capabilities
4. **Advanced Analytics:** Track content performance
5. **A/B Testing:** Test different AI-generated variations
6. **Personalization:** Custom content per user segment

### Integration Improvements
1. **Multi-model Strategy:** Use different models for different tasks
2. **Content Optimization:** SEO optimization, readability scores
3. **Brand Voice Training:** Train on brand-specific content
4. **Real-time Generation:** WebSocket for streaming responses
5. **Batch Processing:** Process multiple requests efficiently

---

**This integration strategy provides a robust foundation for AI content generation within the constraints of the free tier, with fallbacks and optimization strategies to ensure reliability.**
