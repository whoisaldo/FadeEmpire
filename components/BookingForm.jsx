import { useEffect, useMemo, useState } from 'react';
import '../styles/bookingForm.css';

const initialFormState = {
  name: '',
  phone: '',
  service: '',
  customService: '',
  date: '',
  time: '',
  notes: ''
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

    while (hour < 17) {
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
        customService: value === 'Custom Request' ? prev.customService : ''
      }));
      return;
    }

    setFormData((prev) => ({ ...prev, [field]: value }));
  };

  const buildMessage = () => {
    const { name, phone, service, customService, date, time, notes } = formData;
    const formattedDate = new Date(date).toLocaleDateString('en-US', {
      weekday: 'long',
      month: 'long',
      day: 'numeric'
    });

    const serviceText = service === 'Custom Request'
      ? `Custom Request: ${customService}`
      : service;

    let message = '🔥 *FADE EMPIRE BOOKING REQUEST* 🔥\n\n';
    message += `👤 *Name:* ${name}\n`;
    if (phone) message += `📱 *Phone:* ${phone}\n`;
    message += `✂️ *Service:* ${serviceText}\n`;
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
          <option value="Classic Cut ($30)">Classic Cut ($30)</option>
          <option value="Fade & Lineup ($35)">Fade &amp; Lineup ($35)</option>
          <option value="Beard Trim ($20)">Beard Trim ($20)</option>
          <option value="Hot Towel Shave ($40)">Hot Towel Shave ($40)</option>
          <option value="Kids Cut ($25)">Kids Cut ($25)</option>
          <option value="Design & Patterns ($45+)">Design &amp; Patterns ($45+)</option>
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

