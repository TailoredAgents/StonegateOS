import { redirect } from 'next/navigation';

export default function PaymentsRedirect(){
  // Payments UI isn't currently exposed as a Team Console tab.
  redirect('/team?tab=owner');
}

