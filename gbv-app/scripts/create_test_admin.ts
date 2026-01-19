
import { createClient } from '@supabase/supabase-js';
import dotenv from 'dotenv';

dotenv.config();

const supabaseUrl = process.env.VITE_SUPABASE_URL;
const supabaseKey = process.env.VITE_SUPABASE_ANON_KEY;

if (!supabaseUrl || !supabaseKey) {
  console.error('Missing env vars');
  process.exit(1);
}

const supabase = createClient(supabaseUrl, supabaseKey);

async function run() {
  const email = 'antigravity_test_admin@example.com';
  const password = 'test-password-123';

  console.log(`Attempting to sign up ${email}...`);

  const { data, error } = await supabase.auth.signUp({
    email,
    password,
  });

  if (error) {
    console.error('Signup failed:', error.message);
    
    // If user already exists, try signing in
    if (error.message.includes('already registered')) {
        console.log('User exists, trying sign in...');
        const { data: signinData, error: signinError } = await supabase.auth.signInWithPassword({
            email,
            password
        });
        if (signinError) {
             console.error('Signin also failed:', signinError.message);
        } else {
            console.log('Signin successful!', signinData.user?.id);
        }
    }
  } else {
    console.log('Signup successful!', data.user?.id);
    console.log('Check your email for confirmation if required, or if auto-confirm is on, you are good to go.');
  }
}

run();
