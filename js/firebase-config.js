import { initializeApp } from "https://www.gstatic.com/firebasejs/10.12.0/firebase-app.js";
import { getAuth }        from "https://www.gstatic.com/firebasejs/10.12.0/firebase-auth.js";
import { getFunctions }   from "https://www.gstatic.com/firebasejs/10.12.0/firebase-functions.js";

const firebaseConfig = {
  apiKey:            "AIzaSyCbgekmh90OPhr7DZJsVS-GXAYMOqtZ3Ds",
  authDomain:        "trilogia-dashboard.firebaseapp.com",
  projectId:         "trilogia-dashboard",
  storageBucket:     "trilogia-dashboard.firebasestorage.app",
  messagingSenderId: "175437497741",
  appId:             "1:175437497741:web:59aa773c374c4eceb429c4"
};

const app = initializeApp(firebaseConfig);

export const auth      = getAuth(app);
export const functions = getFunctions(app, 'us-central1');

// Para desenvolvimento local com o emulador, descomente:
// import { connectAuthEmulator }      from "https://www.gstatic.com/firebasejs/10.12.0/firebase-auth.js";
// import { connectFunctionsEmulator } from "https://www.gstatic.com/firebasejs/10.12.0/firebase-functions.js";
// connectAuthEmulator(auth, 'http://localhost:9099');
// connectFunctionsEmulator(functions, 'localhost', 5001);
