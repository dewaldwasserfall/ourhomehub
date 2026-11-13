/**
 * Web Push (VAPID) settings shared by the browser and the server.
 *
 * The public key is not a secret: browsers need it to subscribe. Its private
 * half lives only in the VAPID_PRIVATE_KEY environment variable on Vercel.
 * The two were generated together; replacing one means replacing both, and
 * every device has to turn notifications on again.
 */
export const VAPID_PUBLIC_KEY = "BKtyzlyhoF9KYegJ5XR1qYEcr6pNvyCFx6k4WqiC-pEBoU8QhoGNAa_-Tk7OGFjLuWok-z1QAcUva7lgXcfRDYs";

/** Contact for the push services (a URL or mailto: is required by the spec). */
export const VAPID_SUBJECT = "https://ourhomehub.nl";
