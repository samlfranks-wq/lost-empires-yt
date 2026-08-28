@echo off
rem One-shot: publish Bronze Age A/B arm 2 (stickman cut), 24h after arm 1.
cd /d C:\Users\samlf\Desktop\Claude\yt-publisher
node post.js --long --confirm --url "C:\Users\samlf\Desktop\Claude\pompeii-remotion\out\BronzeAge_stick_master.mp4" --caption-file "C:\Users\samlf\Desktop\Claude\pompeii-remotion\out\yt_caption.txt" --cover "C:\Users\samlf\Desktop\Claude\pompeii-remotion\out\thumb_stick.png" --title "The 50 Years That Killed Eight Empires" >> bronze_arm2.log 2>&1
