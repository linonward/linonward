import { Benefits } from "@/components/benefits";
import { Faq, faqItems } from "@/components/faq";
import { Footer } from "@/components/footer";
import { Hero } from "@/components/hero";
import { HowItWorks } from "@/components/how-it-works";
import { InterviewForm } from "@/components/interview-form";

const faqJsonLd = {
  "@context": "https://schema.org",
  "@type": "FAQPage",
  mainEntity: faqItems.map(({ question, answer }) => ({
    "@type": "Question",
    name: question,
    acceptedAnswer: { "@type": "Answer", text: answer },
  })),
};

export default function Home() {
  return (
    <main>
      <script
        type="application/ld+json"
        dangerouslySetInnerHTML={{ __html: JSON.stringify(faqJsonLd) }}
      />
      <div id="top">
        <Hero />
      </div>
      <Benefits />
      <HowItWorks />
      <InterviewForm />
      <Faq />
      <Footer />
    </main>
  );
}
