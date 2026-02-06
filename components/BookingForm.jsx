import { useEffect, useMemo, useState } from 'react';
import '../styles/bookingForm.css';

const initialFormState = {
  name: '',
  phone: '',
  service: '',
  customService: '',
  date: '',
  time: '',
  notes: '',
  addons: {
    eyebrows: false,
    hotTowel: false,
    facial: false,
    wax: false
  }
};

const WHATSAPP_NUMBER = '14138854440';

const BookingForm = () => {
  const [formData, setFormData] = useState(initialFormState);
  const [showCustomService, setShowCustomService] = useState(false);
  const [minDate, setMinDate] = useState('');

  useEffect(() => {
    const today = new Date();
    const offset = today.getTimezoneOffset();
    today.setMinutes(today.getMinutes() - offset);
    setMinDate(today.toISOString().split('T')[0]);
  }, []);

  const timeOptions = useMemo(() => {
    const slots = [];
    let hour = 10;
    let minutes = 0;

    while (hour < 18) {
      const suffix = hour >= 12 ? 'PM' : 'AM';
      const displayHour = hour > 12 ? hour - 12 : hour;
      const displayMinutes = minutes === 0 ? '00' : '30';
      const label = `${displayHour}:${displayMinutes} ${suffix}`;
      slots.push(label);

      minutes = minutes === 0 ? 30 : 0;
      if (minutes === 0) hour += 1;
    }

    slots.pop();
    return slots;
  }, []);

  const formatPhoneNumber = (value) => {
    const phone = value.replace(/\D/g, '').slice(0, 10);
    if (phone.length <= 3) return phone;
    if (phone.length <= 6) return `(${phone.slice(0, 3)}) ${phone.slice(3)}`;
    return `(${phone.slice(0, 3)}) ${phone.slice(3, 6)}-${phone.slice(6, 10)}`;
  };

  const handleChange = (field) => (event) => {
    const value = field === 'phone' ? formatPhoneNumber(event.target.value) : event.target.value;

    if (field === 'service') {
      setShowCustomService(value === 'Custom Request');
      setFormData((prev) => ({
        ...prev,
        service: value,
        customService: value === 'Custom Request' ? prev.customService : '',
        // Reset addons if VIP is selected (all included)
        addons: value === 'VIP Haircut ($60)' 
          ? { eyebrows: true, hotTowel: true, facial: true, wax: true }
          : { eyebrows: false, hotTowel: false, facial: false, wax: false }
      }));
      return;
    }

    if (field.startsWith('addon-')) {
      const addonName = field.replace('addon-', '');
      setFormData((prev) => ({
        ...prev,
        addons: {
          ...prev.addons,
          [addonName]: event.target.checked
        }
      }));
      return;
    }

    setFormData((prev) => ({ ...prev, [field]: value }));
  };

  const calculateTotal = () => {
    const servicePrices = {
      'Hair Cut ($30)': 30,
      'Line Up ($10)': 10,
      'Beard Trim ($10)': 10,
      'Kids Cut ($25)': 25,
      'Military Cut ($25)': 25,
      'Senior Cut ($25)': 25,
      'VIP Haircut ($60)': 60
    };
    
    const basePrice = servicePrices[formData.service] || 0;
    if (formData.service === 'VIP Haircut ($60)') {
      return 60; // VIP includes everything
    }
    
    let addonTotal = 0;
    if (formData.addons.hotTowel) addonTotal += 5;
    if (formData.addons.facial) addonTotal += 20;
    if (formData.addons.wax) addonTotal += 5;
    // Eyebrows is free, so no cost added
    
    return basePrice + addonTotal;
  };

  const buildMessage = () => {
    const { name, phone, service, customService, date, time, notes, addons } = formData;
    
    // Parse YYYY-MM-DD directly to avoid any timezone conversion
    const formatDateLocal = (dateString) => {
      if (!dateString) return '';
      const [year, month, day] = dateString.split('-').map(Number);
      
      // Create date object using local time components (month is 0-indexed)
      // Using noon to avoid any midnight timezone edge cases
      const dateObj = new Date(year, month - 1, day, 12, 0, 0);
      
      // Get weekday and month names
      const weekdays = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
      const months = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
      
      // Get the day of week and month from the date object
      const weekday = weekdays[dateObj.getDay()];
      const monthName = months[dateObj.getMonth()];
      
      return `${weekday}, ${monthName} ${day}`;
    };
    
    const formattedDate = formatDateLocal(date);

    const serviceText = service === 'Custom Request'
      ? `Custom Request: ${customService}`
      : service;

    const selectedAddons = [];
    if (addons.eyebrows) selectedAddons.push('Eyebrows (FREE)');
    if (addons.hotTowel) selectedAddons.push('Hot Towel (+$5)');
    if (addons.facial) selectedAddons.push('Facial (+$20)');
    if (addons.wax) selectedAddons.push('Wax (+$5)');

    const total = calculateTotal();

    let message = '🔥 *FADE EMPIRE BOOKING REQUEST* 🔥\n\n';
    message += `👤 *Name:* ${name}\n`;
    if (phone) message += `📱 *Phone:* ${phone}\n`;
    message += `✂️ *Service:* ${serviceText}\n`;
    if (selectedAddons.length > 0 && service !== 'VIP Haircut ($60)') {
      message += `➕ *Add-ons:* ${selectedAddons.join(', ')}\n`;
    }
    if (service === 'VIP Haircut ($60)') {
      message += `➕ *Add-ons:* All included (Hot Towel, Facial, Wax, Eyebrows)\n`;
    }
    message += `💰 *Total:* $${total}\n`;
    message += `📅 *Date:* ${formattedDate}\n`;
    message += `⏰ *Time:* ${time}\n`;
    if (notes) message += `📝 *Notes:* ${notes}\n`;
    message += '\n_Sent from FadeEmpire.com_';

    return message;
  };

  const handleSubmit = (event) => {
    event.preventDefault();

    const message = buildMessage();
    const whatsappURL = `https://wa.me/${WHATSAPP_NUMBER}?text=${encodeURIComponent(message)}`;

    window.open(whatsappURL, '_blank', 'noopener');
  };

  const handleSmsFallback = (event) => {
    event.preventDefault();
    const message = buildMessage().replace(/\*/g, '').replace(/_/g, '');
    window.location.href = `sms:4138854440?&body=${encodeURIComponent(message)}`;
  };

  return (
    <form className="booking-form" onSubmit={handleSubmit} noValidate>
      <h2 className="form-title">BOOK YOUR APPOINTMENT</h2>

      <div className="form-row">
        <div className="form-group">
          <label htmlFor="booking-name">Full Name *</label>
          <input
            id="booking-name"
            type="text"
            value={formData.name}
            onChange={handleChange('name')}
            placeholder="Your Name"
            required
          />
        </div>
        <div className="form-group">
          <label htmlFor="booking-phone">Phone</label>
          <input
            id="booking-phone"
            type="tel"
            value={formData.phone}
            onChange={handleChange('phone')}
            placeholder="(413) 885-4440"
            inputMode="tel"
          />
        </div>
      </div>

      <div className="form-group">
        <label htmlFor="booking-service">Service *</label>
        <select
          id="booking-service"
          value={formData.service}
          onChange={handleChange('service')}
          required
        >
          <option value="">Select a service</option>
          <option value="Hair Cut ($30)">Hair Cut ($30)</option>
          <option value="Line Up ($10)">Line Up ($10)</option>
          <option value="Beard Trim ($10)">Beard Trim ($10)</option>
          <option value="Kids Cut ($25)">Kids Cut ($25)</option>
          <option value="Military Cut ($25)">Military Cut ($25)</option>
          <option value="Senior Cut ($25)">Senior Cut ($25)</option>
          <option value="VIP Haircut ($60)">VIP Haircut ($60)</option>
          <option value="Custom Request">Custom Request (Describe Below)</option>
        </select>
      </div>

      {showCustomService && (
        <div className="form-group">
          <label htmlFor="booking-custom-service">Describe Your Custom Service *</label>
          <textarea
            id="booking-custom-service"
            value={formData.customService}
            onChange={handleChange('customService')}
            placeholder="Describe your desired haircut, design, or style..."
            rows={3}
            required
          />
        </div>
      )}

      {formData.service && formData.service !== 'Custom Request' && formData.service !== 'VIP Haircut ($60)' && (
        <div className="form-group">
          <label>Add-ons (Optional)</label>
          <div className="form-addons">
            <label>
              <input
                type="checkbox"
                checked={formData.addons.eyebrows}
                onChange={handleChange('addon-eyebrows')}
              />
              Eyebrows (FREE)
            </label>
            <label>
              <input
                type="checkbox"
                checked={formData.addons.hotTowel}
                onChange={handleChange('addon-hotTowel')}
              />
              Hot Towel (+$5)
            </label>
            <label>
              <input
                type="checkbox"
                checked={formData.addons.facial}
                onChange={handleChange('addon-facial')}
              />
              Facial (+$20)
            </label>
            <label>
              <input
                type="checkbox"
                checked={formData.addons.wax}
                onChange={handleChange('addon-wax')}
              />
              Wax (+$5)
            </label>
          </div>
          <div className="form-total">
            Total: $<strong>{calculateTotal()}</strong>
          </div>
        </div>
      )}

      {formData.service === 'VIP Haircut ($60)' && (
        <div className="form-group">
          <div className="form-vip-note">
            VIP package includes all add-ons: Hot Towel, Facial, Wax, and Eyebrows
          </div>
          <div className="form-total">
            Total: $<strong>60</strong>
          </div>
        </div>
      )}

      <div className="form-row">
        <div className="form-group">
          <label htmlFor="booking-date">Preferred Date *</label>
          <input
            id="booking-date"
            type="date"
            value={formData.date}
            onChange={handleChange('date')}
            min={minDate}
            required
          />
        </div>
        <div className="form-group">
          <label htmlFor="booking-time">Preferred Time *</label>
          <select
            id="booking-time"
            value={formData.time}
            onChange={handleChange('time')}
            required
          >
            <option value="">Select time</option>
            {timeOptions.map((slot) => (
              <option key={slot} value={slot}>
                {slot}
              </option>
            ))}
          </select>
        </div>
      </div>

      <div className="form-group">
        <label htmlFor="booking-notes">Additional Notes</label>
        <textarea
          id="booking-notes"
          value={formData.notes}
          onChange={handleChange('notes')}
          placeholder="Any special requests or important info?"
          rows={3}
        />
      </div>

      <button type="submit" className="submit-btn">
        <span aria-hidden="true">💬</span>
        Send Booking via WhatsApp
      </button>

      <button className="sms-link" onClick={handleSmsFallback}>
        Or send via regular text message
      </button>
    </form>
  );
};

export default BookingForm;

