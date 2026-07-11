#!/bin/bash
# Image optimization script for mobile

cd "$(dirname "$0")"

echo "Optimizing images for mobile..."

# Optimize gallery images (max width 800px for mobile, quality 85%)
for img in assets/Haircuts/*.jpg; do
  if [ -f "$img" ]; then
    filename=$(basename "$img" .jpg)
    echo "Optimizing $filename..."
    # Create mobile version (800px width, 85% quality)
    sips -Z 800 -s formatOptions 85 "$img" --out "assets/Haircuts/optimized/${filename}_mobile.jpg" 2>/dev/null
    # Create tablet version (1200px width, 90% quality)
    sips -Z 1200 -s formatOptions 90 "$img" --out "assets/Haircuts/optimized/${filename}_tablet.jpg" 2>/dev/null
  fi
done

# Optimize logo (max 200px for mobile)
if [ -f "assets/FadeEmpireStore/fadeempirelogo.png" ]; then
  echo "Optimizing logo..."
  sips -Z 200 -s formatOptions 90 "assets/FadeEmpireStore/fadeempirelogo.png" --out "assets/FadeEmpireStore/optimized/fadeempirelogo_mobile.png" 2>/dev/null
  sips -Z 400 "assets/FadeEmpireStore/fadeempirelogo.png" --out "assets/FadeEmpireStore/optimized/fadeempirelogo_tablet.png" 2>/dev/null
fi

# Optimize hero background (max 1200px width for mobile)
if [ -f "assets/FadeEmpireStore/FadeEmpireStoreFront.JPG" ]; then
  echo "Optimizing hero background..."
  sips -Z 1200 -s formatOptions 85 "assets/FadeEmpireStore/FadeEmpireStoreFront.JPG" --out "assets/FadeEmpireStore/optimized/FadeEmpireStoreFront_mobile.jpg" 2>/dev/null
  sips -Z 1920 -s formatOptions 90 "assets/FadeEmpireStore/FadeEmpireStoreFront.JPG" --out "assets/FadeEmpireStore/optimized/FadeEmpireStoreFront_tablet.jpg" 2>/dev/null
fi

# Optimize barber image
if [ -f "assets/Barbers/Hassan/HassanBarber.png" ]; then
  echo "Optimizing barber image..."
  sips -Z 600 -s formatOptions 90 "assets/Barbers/Hassan/HassanBarber.png" --out "assets/Barbers/Hassan/optimized/HassanBarber_mobile.png" 2>/dev/null
  sips -Z 800 "assets/Barbers/Hassan/HassanBarber.png" --out "assets/Barbers/Hassan/optimized/HassanBarber_tablet.png" 2>/dev/null
fi

echo "Image optimization complete!"


# Optimize Larry's barber image (HEIC source → web JPGs)
if [ -f "assets/Barbers/Larry/Larry.heic" ]; then
  echo "Optimizing Larry's image..."
  sips -s format jpeg -s formatOptions 92 "assets/Barbers/Larry/Larry.heic" --out "assets/Barbers/Larry/LarryBarber.jpg" 2>/dev/null
  sips -Z 600 -s format jpeg -s formatOptions 85 "assets/Barbers/Larry/Larry.heic" --out "assets/Barbers/Larry/optimized/LarryBarber_mobile.jpg" 2>/dev/null
  sips -Z 800 -s format jpeg -s formatOptions 90 "assets/Barbers/Larry/Larry.heic" --out "assets/Barbers/Larry/optimized/LarryBarber_tablet.jpg" 2>/dev/null
fi

# Optimize Javier's barber image (HEIC source → web JPGs)
# (Javier retired July 2026 — kept for the record; the guard makes it a no-op.)
if [ -f "assets/Barbers/Javier/IMG_1732.heic" ]; then
  echo "Optimizing Javier's image..."
  sips -s format jpeg -s formatOptions 92 "assets/Barbers/Javier/IMG_1732.heic" --out "assets/Barbers/Javier/JavierBarber.jpg" 2>/dev/null
  sips -Z 600 -s format jpeg -s formatOptions 85 "assets/Barbers/Javier/IMG_1732.heic" --out "assets/Barbers/Javier/optimized/JavierBarber_mobile.jpg" 2>/dev/null
  sips -Z 800 -s format jpeg -s formatOptions 90 "assets/Barbers/Javier/IMG_1732.heic" --out "assets/Barbers/Javier/optimized/JavierBarber_tablet.jpg" 2>/dev/null
fi
