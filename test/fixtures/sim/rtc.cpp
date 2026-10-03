#include <RTClib.h>
RTC_DS1307 rtc;
void show() {
  DateTime n = rtc.now();
  char buf[40];
  snprintf(buf, sizeof buf, "now=%04d-%02d-%02d %02d:%02d:%02d", n.year(), n.month(), n.day(), n.hour(), n.minute(), n.second());
  Serial.println(buf);
}
void setup() {
  Serial.begin(115200);
  if (!rtc.begin()) { Serial.println("rtc fail"); for (;;); }
  Serial.println(rtc.isrunning() ? "running" : "stopped");
  show();
  rtc.adjust(DateTime(2024, 1, 2, 3, 4, 5));
  delay(2000);
  show();
}
void loop() {}
