# Fade Empire Barbershop Website

A modern, luxury barbershop website built for **Fade Empire** in Chicopee, Massachusetts. This is a freelance project designed to showcase services, portfolio, and provide an easy booking experience for clients.

## 🎯 Project Overview

Fade Empire is a premium barbershop offering precision fades, custom designs, beard trims, and white-glove grooming services. This website serves as their digital presence, featuring:

- **Service showcase** with pricing and descriptions
- **Portfolio gallery** displaying client transformations
- **Booking system** via WhatsApp/SMS integration
- **Responsive design** optimized for mobile and desktop
- **Modern UI/UX** with luxury aesthetic

## 🛠️ Tech Stack

### Frontend
- **HTML5** - Semantic markup
- **CSS3** - Custom styling with:
  - CSS Grid & Flexbox for layouts
  - CSS Variables for theming
  - Responsive design with mobile-first approach
  - Custom animations and transitions
- **JavaScript (ES6+)** - Vanilla JS for:
  - DOM manipulation
  - Form handling
  - Lightbox gallery
  - Scroll animations
  - WhatsApp/SMS booking integration

### Styling Architecture
- `styles/globals.css` - Main stylesheet with component styles
- `styles/responsive.css` - Mobile/tablet/desktop breakpoints
- `styles/bookingForm.css` - Booking form specific styles
- `styles/animations.css` - Animation keyframes and transitions

### Components
- **React** (via JSX) - `components/BookingForm.jsx` for the booking form
- **Vanilla JS** - All other functionality (no framework dependencies)

### Assets
- Optimized images (mobile/tablet/desktop variants)
- Responsive image loading with `srcset` and `sizes`
- Lazy loading for performance

### Development
- **Local server** - Python `http.server` or Node.js `http-server`
- **No build process** - Pure static site (HTML/CSS/JS)
- **Expo** (optional) - For mobile app wrapper via WebView

## 📁 Project Structure

```
FadeEmpire/
├── index.html              # Main HTML file
├── script.js               # JavaScript functionality
├── components/
│   └── BookingForm.jsx    # React booking form component
├── styles/
│   ├── globals.css        # Main stylesheet
│   ├── responsive.css     # Responsive breakpoints
│   ├── bookingForm.css    # Form styles
│   └── animations.css     # Animations
└── assets/
    ├── Haircuts/          # Portfolio images
    ├── Barbers/           # Barber profiles
    └── FadeEmpireStore/   # Branding assets
```

## 🚀 Getting Started

### Prerequisites
- Python 3.x (for local server) OR Node.js (for http-server)
- Modern web browser

### Local Development

1. **Clone or navigate to the project:**
   ```bash
   cd FadeEmpire
   ```

2. **Start a local server:**
   
   **Option A: Python**
   ```bash
   python3 -m http.server 8000
   ```
   
   **Option B: Node.js**
   ```bash
   npx http-server -p 8000
   ```

3. **Open in browser:**
   ```
   http://localhost:8000
   ```

### Mobile Testing

**On iPhone (same Wi-Fi network):**
```
http://YOUR_MAC_IP:8000
```
Find your Mac's IP: `ifconfig | grep "inet " | grep -v 127.0.0.1`

**iOS Simulator:**
```bash
xcrun simctl boot "iPhone 17 Pro Max"
xcrun simctl openurl booted "http://YOUR_MAC_IP:8000"
```

## 📱 Features

- ✅ Responsive 2-column mobile grid (services & gallery)
- ✅ 3-column desktop layout
- ✅ WhatsApp/SMS booking integration
- ✅ Portfolio gallery with lightbox (disabled)
- ✅ Service pricing and descriptions
- ✅ Store hours and location
- ✅ Smooth scroll animations
- ✅ Mobile-optimized images
- ✅ Developer contact button

## 🎨 Design Philosophy

- **Luxury aesthetic** - Gold accents, dark theme, premium feel
- **Mobile-first** - Optimized for phone users
- **Performance** - Lazy loading, optimized images, minimal dependencies
- **Accessibility** - Semantic HTML, ARIA labels, keyboard navigation

## 📝 Notes

- This is a **freelance project** for a local barbershop
- Static site - no backend required
- Booking handled via WhatsApp/SMS (no server-side processing)
- All images are optimized for web (mobile/tablet/desktop variants)

## 👨‍💻 Developer

Built by **Ali Younes**  
Contact: aliyounes@eternalreverse.com

---

© 2025 Fade Empire. All rights reserved.

