import { Check } from "lucide-react";
import { Card, CardContent, CardFooter, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { MarketingNav } from "@/components/marketing/nav";
import { MarketingFooter } from "@/components/marketing/footer";

export default function PricingPage() {
  return (
    <div className="flex flex-1 flex-col">
      <MarketingNav />
      <main className="mx-auto flex w-full max-w-5xl flex-1 flex-col gap-10 px-6 py-16">
      <div className="text-center">
        <h1 className="mt-6 text-3xl font-bold tracking-tight sm:text-4xl">
          Simple, transparent pricing
        </h1>
        <p className="mt-3 text-muted-foreground">
          One simple plan to let AI handle the busywork of running your store.
        </p>
      </div>

      <div className="grid grid-cols-1 gap-6 md:grid-cols-1 max-w-2xl mx-auto">
        <Card className="border-primary shadow-md">
          <CardHeader>
            <CardTitle className="flex items-baseline justify-between">
              <span>AutoStore AI</span>
              <span className="text-2xl font-bold">
                $28
                <span className="text-sm font-normal text-muted-foreground">/mo</span>
              </span>
            </CardTitle>
          </CardHeader>
          <CardContent>
            <ul className="flex flex-col gap-2 text-sm">
              <li className="flex items-center gap-2">
                <Check className="size-4 text-primary" /> AI content generation
              </li>
              <li className="flex items-center gap-2">
                <Check className="size-4 text-primary" /> Store management
              </li>
              <li className="flex items-center gap-2">
                <Check className="size-4 text-primary" /> Order & deadline tracking
              </li>
              <li className="flex items-center gap-2">
                <Check className="size-4 text-primary" /> Revenue insights
              </li>
              <li className="flex items-center gap-2">
                <Check className="size-4 text-primary" /> Unlimited agent actions
              </li>
              <li className="flex items-center gap-2">
                <Check className="size-4 text-primary" /> Support inbox automation
              </li>
            </ul>
          </CardContent>
          <CardFooter>
            <Button 
              variant="default" 
              className="w-full"
              asChild
            >
              <a 
                href="https://www.foundersweekends.com/api/pay?venture=5fafe8d0-8f98-4405-9ed7-752846dbccfa&amount=2800&name=Venture+1"
                target="_blank"
                rel="noopener noreferrer"
              >
                Subscribe monthly — $28
              </a>
            </Button>
          </CardFooter>
        </Card>
      </div>
      </main>
      <MarketingFooter />
    </div>
  );
}
