import "dotenv/config";
import { cleanupExpiredAppointmentMedia } from "../src/lib/appointment-media";

void cleanupExpiredAppointmentMedia()
  .then((result) => {
    console.log(
      JSON.stringify({ ok: result.failures === 0, ...result }, null, 2),
    );
    if (result.failures > 0) process.exitCode = 1;
  })
  .catch((error) => {
    console.error(error);
    process.exitCode = 1;
  });
